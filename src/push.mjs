// `push` and `pull`: move a scaffolded site to a live host and back, over
// https, with no SSH. Shared cPanel hosting (the target this was built for)
// hands out accounts with no shell at all - on the reseller it was first used
// against, 28 of 28 accounts were `noshell` - so git-deploy and rsync are not
// options and everything has to fit through ordinary web requests.
//
// This file is deliberately a PIPE. All the real work - exporting a
// database, hashing files, applying a design - is done by one PHP plugin
// (src/push/agentpress-push/agentpress-push.php) that runs on BOTH ends: on
// the remote site behind a REST route, on the local site through WP-CLI.
// Node only asks each end to do a step, and carries the resulting file from
// one to the other. That is what keeps the two ends in the same dialect: an
// export is always read by the same code that wrote it.
//
// The rule that makes two-way safe:
//   design  is owned by LOCAL and only goes UP   (push)
//   content is owned by LIVE  and only comes DOWN (pull)
// A whole-database copy happens in exactly two places: the first push to an
// empty site (`push --full`), and a pull.
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { deflateRawSync } from 'node:zlib';
import { bold, cyan, dim, envOn, green, pink, red, yellow, BAD, INFO, OK, STEP, WARN } from './ansi.mjs';
import { firstPhpDiagnostic, runWp } from './wp.mjs';

export const PLUGIN_SLUG = 'agentpress-push';
export const PLUGIN_FILE = `${PLUGIN_SLUG}.php`;
const PLUGIN_SOURCE = fileURLToPath(new URL(`./push/${PLUGIN_SLUG}/${PLUGIN_FILE}`, import.meta.url));
const JSON_MARK = 'AGENTPRESS_PUSH_JSON ';
/**
 * Plugin folders the scaffold installs to give agents their MCP endpoint (see
 * installAgentConnector in plugins.mjs). They carry shell-exec, PHP-eval and
 * filesystem-write abilities - the product on a dev machine, a remote-code
 * hole on a public server. So they are LOCAL-ONLY in both directions: a pull
 * keeps them switched on here whatever live says, and a push never sends
 * their files and never switches them on there.
 */
export const LOCAL_AGENT_PLUGINS = ['agent-connector-for-wp', 'universal-abilities-plugin'];

/**
 * What those plugins keep in the DATABASE, which is local-only for the same
 * reason and was the half nobody had listed. First full copy onto the real
 * server after a pull (2026-11-12): the connector's three OAuth tables and
 * its settings went up with everything else (the tables were empty that day;
 * on a site whose agent signs in with OAuth they are its credentials), and
 * `push undo --full` left the tables on live, because undo only swaps back
 * what the kept set names. Neither end reads these tables into a copy, the
 * receiver refuses them if they arrive anyway, and each site keeps its own
 * settings through the switch.
 *
 * Tables by WHOLE name: `acfw_` is also the prefix of a coupons plugin for
 * WooCommerce, and a shop's own tables must travel. Settings by prefix: the
 * long one is the connector's alone.
 */
export const LOCAL_AGENT_TABLES = ['acfw_oauth_clients', 'acfw_oauth_codes', 'acfw_oauth_tokens', 'acfw_mcp_events'];
export const LOCAL_AGENT_OPTIONS = ['agent_connector_for_wp_'];

/**
 * A file list with the local-only agent plugins taken out. Applied to the
 * SOURCE list before the compare, so those files are not sent, not counted in
 * the byte total and not shown in a dry run. Caught before any real server
 * was touched (2026-11-11): the first full push copied the whole plugins
 * folder, abilities pack included, and the copied database switched it on.
 */
export function withoutLocalOnlyPlugins(manifest) {
  const kept = new Map();
  for (const [path, file] of manifest) {
    if (!LOCAL_AGENT_PLUGINS.some((dir) => path.startsWith(`plugins/${dir}/`))) kept.set(path, file);
  }
  return kept;
}

/**
 * A file list with the themes this site does not run on taken out. `inUse` is
 * the local site's own answer (`info.themes_in_use`). First real site,
 * 2026-11-12: the three default themes had been removed from live on purpose
 * (Oxygen runs with themes off), they were still in the local folder, and
 * every design push offered all 393 files back. "The theme the design needs"
 * is the one WordPress is running, not every folder beside it. Files directly
 * under themes/ stay. A full copy is not filtered: that one is a copy.
 */
export function withoutUnusedThemes(manifest, inUse) {
  if (!Array.isArray(inUse)) return manifest;
  const kept = new Map();
  for (const [path, file] of manifest) {
    const parts = path.split('/');
    if (parts[0] !== 'themes' || parts.length < 3 || inUse.includes(parts[1])) kept.set(path, file);
  }
  return kept;
}

/**
 * What each command is called in the site menu (template/scripts/agentpress.mjs).
 * The labels are the frozen menu's own text; test/parity.test.mjs pins the two
 * together, because a hint naming an item the menu does not have is worse than
 * a long command.
 */
export const MENU_LABELS = {
  'push plugin': 'Make the plugin zip',
  'push connect': 'Connect',
  'push status': 'Check status',
  'push --dry-run': 'Preview a design push',
  push: 'Push design to live',
  pull: 'Pull content from live',
  'push --full': 'First launch: full copy to live',
  'push undo': 'Undo… → The last design push',
  'pull undo': 'Undo… → The last pull',
  'push undo --full': 'Undo… → The last full copy',
};

/**
 * How to name a command to the person reading. From a terminal that is the
 * command itself. From the site menu (AGENTPRESS_MENU, which the menu sets on
 * everything it runs) it is the menu item: the menu exists so nobody pastes
 * `node C:\\...\\index.js push undo --full`, and printing exactly that at
 * someone who is inside the menu sends them back to the clipboard.
 */
export function say(site, command, tail = '') {
  const label = envOn('AGENTPRESS_MENU') ? MENU_LABELS[command] : null;
  return label ? `${pink(label)} ${dim('in this menu')}` : pink(`${site.cli} ${command}${tail}`);
}

/** An error whose message is already written for the person at the terminal. */
export class PushError extends Error {}

/* ---------------------------------------------------------------- pure -- */

/**
 * The line Tools > AgentPress Push shows once: `agentpress-push:<base64url>`
 * wrapping {v, url, key}. One opaque token rather than a URL and a key to
 * paste separately, because the pair that gets pasted wrong is always the pair.
 */
export function parseConnection(text) {
  const raw = String(text ?? '').trim().replace(/\s+/g, '');
  const match = /^agentpress-push:([A-Za-z0-9_-]+)$/.exec(raw);
  if (!match) throw new PushError('That is not a connection line. It starts with "agentpress-push:" and comes from Tools > AgentPress Push on the live site.');
  let data;
  try {
    data = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    throw new PushError('That connection line is damaged (it may have been cut short when copied).');
  }
  if (data?.v !== 1 || typeof data.url !== 'string' || typeof data.key !== 'string' || !/^[a-f0-9]{32,}$/.test(data.key)) {
    throw new PushError('That connection line was made by a different version of AgentPress Push.');
  }
  let url;
  try {
    url = new URL(data.url);
  } catch {
    throw new PushError('That connection line holds an address that is not a URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new PushError('That connection line holds an address that is not a web URL.');
  // The address goes into .env, one KEY=value per line. The URL parser
  // silently DROPS line breaks, so an address of "https://live.example/\nDB_NAME=other"
  // passed every check above while the raw text, written as it came, added a
  // DB_NAME line of its own - and .env is last-wins, so a later `destroy`
  // would have dropped a database the line named (security review,
  // 2026-11-11; the injection was reproduced, the drop was not run). Refuse
  // the control characters, and hand back the parsed form, not the sent one.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(data.url) || url.username || url.password || url.search || url.hash) {
    throw new PushError('That connection line holds an address with something extra in it. Create a new key on the live site and copy the line again.');
  }
  return { url: `${url.origin}${url.pathname}`.replace(/\/+$/, ''), key: data.key };
}

/**
 * Text that came from the other site, made safe to print. A live site that
 * has been tampered with chooses its own titles, logins and error messages,
 * and an escape sequence in one of them could repaint the plan this tool is
 * asking the developer to approve.
 */
export function shown(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** shown() over every string in a small answer that is only read, never sent back. */
function shownDeep(value) {
  if (typeof value === 'string') return shown(value);
  if (Array.isArray(value)) return value.map(shownDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shownDeep(v)]));
  return value;
}

/** Hosts that never leave this machine, so plain http to them publishes nothing. */
export function isLocalHost(hostname) {
  // Not .local: that is mDNS, another device on the network.
  return /(\.test|\.localhost)$|^localhost$|^127\.\d+\.\d+\.\d+$/i.test(String(hostname));
}

/** Set KEY=value lines in .env text, replacing a key in place and keeping every other line byte for byte. */
export function upsertEnv(text, pairs) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
  for (const [key, value] of Object.entries(pairs)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (value === null) {
      if (at !== -1) lines.splice(at, 1);
    } else if (at !== -1) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return lines.join(eol) + eol;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A minimal .zip writer, enough for WordPress's "Upload Plugin" to accept.
 * Hand-rolled for the same reason src/ansi.mjs is: this package has no
 * dependencies and "nothing to npm install" is a property worth ~40 lines.
 * `entries` is [{ name, data: Buffer }]; names use forward slashes.
 */
export function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0, 10); // time
    head.writeUInt16LE(0x21, 12); // date: 1980-01-01, the format's zero
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, nameBytes, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(0, 38); // external attributes
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += head.length + nameBytes.length + packed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

/** manifest.ndjson text -> Map(path -> {s, h}). */
export function parseManifest(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    map.set(row.p, { s: row.s, h: row.h });
  }
  return map;
}

/**
 * What has to travel from `source` to `target`.
 *   mode 'mirror'  - anything missing or different (the source owns these files)
 *   mode 'missing' - only what the target lacks; a file both sides have is left
 *                    alone even when it differs (the target owns these files)
 * Nothing is ever deleted on the target in either mode: `extra` is reported,
 * not acted on, because a file the source does not have is not thereby unwanted.
 */
export function diffManifests(source, target, mode = 'mirror') {
  const send = [];
  let bytes = 0;
  for (const [path, file] of source) {
    const there = target.get(path);
    if (!there || (mode === 'mirror' && there.h !== file.h)) {
      send.push(path);
      bytes += file.s;
    }
  }
  const extra = [];
  for (const path of target.keys()) if (!source.has(path)) extra.push(path);
  return { send, bytes, extra };
}

/**
 * Upload files this site has seen ON LIVE.
 *
 * A design push sends upload files live "does not have", by file, and that
 * cannot tell "live never had this" from "live had it and the editor deleted
 * it". Seen on the real server, 2026-11-11: a story and its image were
 * deleted on live, the files were still on local from the pull, and the next
 * dry run offered to put all ten back. That is this tool writing into the
 * editor's folder, which is the one thing a design push promises not to do.
 *
 * So every operation that leaves a file on both ends writes its path down
 * here, and a design push holds back a missing file whose path is already
 * written down: live had it once, so its absence is somebody's decision.
 *
 * Kept in the project root, not under public/: it is a list of file names,
 * and nothing readable belongs in the web root under a guessable name. It is
 * tied to one live host, so reconnecting to a different site starts empty.
 * No file yet (a site connected before 1.11.0's ledger, or never pulled)
 * means nothing is held back, which is the old behaviour.
 */
export const SEEN_FILE = '.agentpress-push-seen.json';

export async function readSeen(siteDir, host) {
  try {
    const data = JSON.parse(await readFile(join(siteDir, SEEN_FILE), 'utf8'));
    return data.host === host && Array.isArray(data.paths) ? new Set(data.paths) : new Set();
  } catch {
    return new Set();
  }
}

/** Adds every uploads/ path in `lists` to what this site has seen on `host`. */
export async function recordSeen(siteDir, host, ...lists) {
  const seen = await readSeen(siteDir, host);
  for (const list of lists) for (const path of list) if (path.startsWith('uploads/')) seen.add(path);
  await writeFile(join(siteDir, SEEN_FILE), JSON.stringify({ host, paths: [...seen].sort() }) + '\n', 'utf8');
  return seen.size;
}

/** Splits a 'missing' plan into what really is new to live and what live has had before. */
export function holdBackDeleted(plan, seen) {
  const send = [];
  const held = [];
  let bytes = 0;
  for (const path of plan.send) {
    if (seen.has(path)) held.push(path);
    else {
      send.push(path);
      bytes += plan.source?.get(path)?.s ?? 0;
    }
  }
  return { ...plan, send, bytes, held };
}

/**
 * The ledger is bookkeeping for the NEXT push. Failing to write it must not
 * turn a finished push into a failed one, but it must not pass unseen either:
 * without it the next design push goes back to re-sending deleted files.
 */
async function noteSeen(site, host, ...lists) {
  try {
    await recordSeen(site.cwd, host, ...lists);
  } catch (err) {
    console.log(`${yellow(WARN)} Could not write ${SEEN_FILE} (${err.code || err.message}). The next design push may re-send files that were deleted on ${host}.`);
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * How big a chunk to send. PHP refuses a request body over post_max_size
 * with an EMPTY $_POST and no error, which reads as "the upload vanished";
 * staying at half the limit leaves room for the host's own overhead.
 */
export function chunkSizeFor(postMaxBytes) {
  const limit = Number(postMaxBytes) > 0 ? Number(postMaxBytes) : 8 * 1024 * 1024;
  return Math.max(256 * 1024, Math.min(4 * 1024 * 1024, Math.floor(limit / 2)));
}

/** The design plan, as lines a person can read before saying yes. */
export function describeDesignPlan(result) {
  const lines = [];
  const label = { create: 'new', restore: 'new', adopt: 'match', update: 'change', bin: 'remove' };
  for (const change of result.changes ?? []) {
    // A match that changes nothing only records which post is which. True, but
    // not something to ask a person to approve seventeen times.
    if (change.action === 'same' || (change.action === 'adopt' && !(change.changed ?? []).length)) continue;
    const kind = shown(change.type).replace(/^(oxygen|breakdance)_/, '');
    lines.push(`${shown(label[change.action] ?? change.action).padEnd(7)} ${kind.padEnd(9)} ${shown(change.title)}`);
  }
  for (const [part, verdict] of Object.entries(result.site ?? {})) {
    if (verdict === 'update') lines.push(`${'change'.padEnd(7)} ${'site'.padEnd(9)} ${shown(part).replace(/_/g, ' ')}`);
  }
  return lines;
}

/* ----------------------------------------------------------- endpoints -- */

/**
 * The local site, driven through WP-CLI. Every call is one `wp` process that
 * prints one marked JSON line; anything else on stdout (a plugin's stray
 * notice, PHP's own diagnostics - see wp.mjs on why those arrive on STDOUT)
 * is ignored rather than parsed.
 */
export function localEndpoint(publicDir) {
  const dirs = new Map();
  async function wp(args) {
    const res = await runWp(args, { path: publicDir });
    const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith(JSON_MARK));
    if (!line) {
      const why = firstPhpDiagnostic(res.stdout) || res.stderr.trim().split(/\r?\n/).pop() || `wp exited ${res.code}`;
      throw new PushError(`The local site did not answer (${args.slice(0, 3).join(' ')}): ${why}`);
    }
    const data = JSON.parse(line.slice(JSON_MARK.length));
    if (data && data.error) throw new PushError(data.error.message);
    return data;
  }
  return {
    label: 'local',
    isLocal: true,
    async run(op, args = {}) {
      const file = join(tmpdir(), `agentpress-push-args-${randomBytes(6).toString('hex')}.json`);
      await writeFile(file, JSON.stringify(args), 'utf8');
      try {
        const data = await wp([PLUGIN_SLUG, 'run', op, `--args-file=${file}`]);
        if (op === 'session_new') dirs.set(data.session, data.dir);
        return data;
      } finally {
        await rm(file, { force: true });
      }
    },
    mintKey: () => wp([PLUGIN_SLUG, 'key']),
    async putFile(session, name, path) {
      await copyFile(path, join(dirs.get(session), name));
    },
    async getFile(session, name, path) {
      await copyFile(join(dirs.get(session), name), path);
    },
  };
}

/**
 * A remote site, over its REST API. `?rest_route=` rather than /wp-json/, so
 * it works on a site whose permalinks are still "Plain" - which a brand new
 * install on the server is.
 */
export function remoteEndpoint({ url, key }, { fetchImpl = globalThis.fetch } = {}) {
  // Checked here as well as at `push connect`: the address is read back from
  // .env on every run, and a hand-edited http:// there would send the key in
  // the clear before the plugin got the chance to refuse it.
  {
    const target = new URL(url);
    if (target.protocol !== 'https:' && !isLocalHost(target.hostname)) {
      throw new PushError(`${target.host} is not on https, so the connection key would travel in the clear. Fix PUSH_REMOTE_URL in .env, or connect again.`);
    }
  }
  // No two requests share an address. A page cache on the server keys on the
  // address, and on the first real server (LiteSpeed) it answered the second
  // download of manifest.ndjson with its stored copy of the first, a different
  // manifest. The plugin now forbids caching its answers; this is the half
  // that still holds if some cache in between ignores that.
  let sent = 0;
  const stamp = Date.now().toString(36);
  const route = (name, query = {}) => {
    const u = new URL(`${url}/`);
    u.searchParams.set('rest_route', `/agentpress-push/v1/${name}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    u.searchParams.set('ap_n', `${stamp}${(sent++).toString(36)}`);
    return u.toString();
  };
  let chunk = chunkSizeFor(0);

  async function request(target, init, { raw = false } = {}) {
    let lastError;
    // Retried: a dropped connection, and the gateway errors a busy shared
    // host answers with. Every operation is safe to repeat - steps resume
    // from the state they are handed, and a chunk names the offset it belongs at.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
      let res;
      try {
        res = await fetchImpl(target, { ...init, headers: { 'X-AgentPress-Key': key, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(120_000), redirect: 'manual' });
      } catch (err) {
        lastError = new PushError(`Could not reach ${new URL(url).host}: ${err?.cause?.code || err?.cause?.message || err.message}`);
        continue;
      }
      if ([502, 503, 504].includes(res.status)) {
        lastError = new PushError(`${new URL(url).host} answered ${res.status} (the server is busy or restarting).`);
        continue;
      }
      if (res.status >= 300 && res.status < 400) {
        // Followed by hand would mean re-sending the key to wherever the
        // redirect points. Say where it went instead.
        throw new PushError(`${new URL(url).host} redirected to ${shown(res.headers.get('location'))}. Reconnect using the address the site really lives at.`);
      }
      if (raw && res.ok) {
        // The body is read INSIDE the retry loop. Headers arriving is not the
        // download arriving: read outside, a connection that dropped halfway
        // through a chunk threw past every retry and ended the whole job.
        try {
          return { headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
        } catch (err) {
          lastError = new PushError(`The download from ${new URL(url).host} was cut off: ${err?.cause?.code || err?.cause?.message || err.message}`);
          continue;
        }
      }
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        // A password lock in front of the whole site (the hosting panel's
        // "password protection") answers before WordPress runs. Seen on the
        // real server, 2026-11-12, where the old message asked whether the
        // plugin was installed: it was, and nothing could reach it.
        if (res.status === 401 && /^\s*basic\b/i.test(res.headers?.get?.('www-authenticate') ?? '')) {
          throw new PushError(
            `${new URL(url).host} is behind a password lock: the server asks for a username and password before WordPress runs, and this tool cannot pass it. ` +
              'Switch the lock off in the hosting panel while you push or pull, then switch it on again.',
          );
        }
        const plain = shown(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
        throw new PushError(`${new URL(url).host} answered ${res.status} with something that is not AgentPress Push${plain ? `: ${plain}` : ''}. Is the plugin installed and active there?`);
      }
      if (!res.ok || (data && data.code && data.message && data.data?.status)) {
        if (data?.code === 'rest_no_route') throw new PushError(`AgentPress Push is not active on ${new URL(url).host}. Install and activate the plugin there first.`);
        throw new PushError(shown(data?.message) || `${new URL(url).host} answered ${res.status}.`);
      }
      return data;
    }
    throw lastError;
  }

  return {
    label: new URL(url).host,
    isLocal: false,
    async run(op, args = {}) {
      const data = await request(route('run'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, args }) });
      if (op === 'info') chunk = chunkSizeFor(data.post_max_bytes);
      return data;
    },
    async putFile(session, name, path, onProgress = () => {}) {
      const { size } = await stat(path);
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(chunk);
        for (let offset = 0; offset < size || (size === 0 && offset === 0); ) {
          const { bytesRead } = await handle.read(buffer, 0, chunk, offset);
          await request(route('put', { session, name, offset }), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer.subarray(0, bytesRead) });
          offset += bytesRead;
          onProgress(offset, size);
          if (bytesRead === 0) break;
        }
      } finally {
        await handle.close();
      }
    },
    async getFile(session, name, path, onProgress = () => {}) {
      const handle = await open(path, 'w');
      try {
        for (let offset = 0, total = Infinity; offset < total; ) {
          const res = await request(route('get', { session, name, offset, length: chunk }), { method: 'GET' }, { raw: true });
          total = Number(res.headers.get('x-agentpress-total'));
          if (!Number.isFinite(total)) throw new PushError(`${new URL(url).host} sent a download with no size. A cache or proxy may be rewriting its answers.`);
          const { bytes } = res;
          if (bytes.length === 0 && offset < total) throw new PushError(`${new URL(url).host} stopped sending partway through a download.`);
          await handle.write(bytes, 0, bytes.length, offset);
          offset += bytes.length;
          onProgress(offset, total);
        }
      } finally {
        await handle.close();
      }
    },
  };
}

/* ------------------------------------------------------------ plumbing -- */

/** Run a stepped operation until it reports done, handing each step the state the last one returned. */
export async function runSteps(endpoint, op, args, onProgress = () => {}) {
  let state;
  let last;
  // Unique per call: the same operation can run twice in one session (two
  // file comparisons in one design push), and step 0 of the second must not
  // be mistaken for step 0 of the first.
  const run = randomBytes(4).toString('hex');
  // A ceiling, not a timeout: 2000 eight-second steps is over four hours. It
  // exists so a step that keeps answering "not done" with no progress cannot spin forever.
  for (let i = 0; i < 2000; i++) {
    // `seq` lets the far end recognise a step it has already answered, so a
    // retry after a lost reply cannot run the same step twice.
    last = await endpoint.run(op, { ...args, state, ...(args.session ? { seq: `${run}:${i}` } : {}) });
    onProgress(last);
    if (last.done) return last;
    state = last.state;
  }
  throw new PushError(`${op} on ${endpoint.label} did not finish.`);
}

/**
 * An operation that is ONE step and must not happen twice: the database
 * switch, an undo, applying a design. request() retries when a reply is lost,
 * and a shared host's gateway gives up at 30 to 60 seconds while PHP carries
 * on and finishes. Retried bare, an undo (which is a swap) ran a second time
 * and put the site back where it started, reported as a success. With a
 * session and a `seq` the receiver answers the retry from its kept reply,
 * and waits for the first attempt if that is still running.
 */
async function runOnce(endpoint, op, args = {}) {
  const own = !args.session;
  const session = args.session ?? (await endpoint.run('session_new')).session;
  try {
    return await endpoint.run(op, { ...args, session, seq: `${randomBytes(4).toString('hex')}:0` });
  } finally {
    if (own) await endpoint.run('session_end', { session }).catch(() => {});
  }
}

function ticker(text) {
  const live = process.stdout.isTTY;
  const write = (suffix) => {
    if (live) process.stdout.write(`\r\x1b[2K  … ${text}${suffix ? dim(` ${suffix}`) : ''}`);
  };
  if (live) write('');
  else console.log(`  … ${text}`);
  return {
    update: write,
    done(receipt) {
      if (live) process.stdout.write('\r\x1b[2K');
      if (receipt) console.log(`  ${dim(`${STEP} ${receipt}`)}`);
    },
  };
}

async function confirm(question, { yes, expect = null } = {}) {
  if (yes && !expect) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(expect ? `? ${question}: ` : `? ${question} [y/N]: `)).trim();
    return expect ? answer === expect : /^y(es)?$/i.test(answer);
  } finally {
    rl.close();
  }
}

/** Copy the receiver into the local site and switch it on. Re-copied whenever this package's copy differs. */
export async function ensureLocalPlugin(publicDir) {
  const dir = join(publicDir, 'wp-content', 'plugins', PLUGIN_SLUG);
  const source = await readFile(PLUGIN_SOURCE);
  const current = await readFile(join(dir, PLUGIN_FILE)).catch(() => null);
  if (!current || !current.equals(source)) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, PLUGIN_FILE), source);
  }
  const res = await runWp(['plugin', 'activate', PLUGIN_SLUG], { path: publicDir });
  if (res.code !== 0) {
    throw new PushError(`Could not switch on the AgentPress Push plugin in the local site: ${firstPhpDiagnostic(res.stdout) || res.stderr.trim().split(/\r?\n/).pop() || `wp exited ${res.code}`}`);
  }
}

export async function pluginZip() {
  return buildZip([{ name: `${PLUGIN_SLUG}/${PLUGIN_FILE}`, data: await readFile(PLUGIN_SOURCE) }]);
}

/** Move one session file from one end to the other, through a temp file on this machine. */
async function carry(from, fromSession, to, toSession, name, work, tick) {
  const path = join(work, `${randomBytes(4).toString('hex')}-${name}`);
  await from.getFile(fromSession, name, path, (done, total) => tick?.update(`down ${formatBytes(done)} of ${formatBytes(total)}`));
  await to.putFile(toSession, name, path, (done, total) => tick?.update(`up ${formatBytes(done)} of ${formatBytes(total)}`));
  const { size } = await stat(path);
  await rm(path, { force: true });
  return size;
}

async function copyDatabase(from, to, sessions, work, swapArgs = {}) {
  let tick = ticker(`reading the database on ${from.label}`);
  const exported = await runSteps(from, 'db_export', { session: sessions.from, own_tables: LOCAL_AGENT_TABLES }, (s) => tick.update(`table ${s.tables_done} of ${s.tables}`));
  tick.done(`read ${exported.rows} rows from ${exported.tables} tables (${formatBytes(exported.bytes)})`);

  tick = ticker(`sending the database to ${to.label}`);
  await carry(from, sessions.from, to, sessions.to, 'db.ndjson', work, tick);
  tick.done();

  tick = ticker(`loading it beside the current one on ${to.label}`);
  const imported = await runSteps(to, 'db_import', { session: sessions.to, own_tables: LOCAL_AGENT_TABLES }, (s) => tick.update(`${formatBytes(s.bytes_done)} of ${formatBytes(s.bytes)}`));
  tick.done(`loaded ${imported.rows} rows; the site is still running on its old database`);
  // The sender was asked to leave the agent connector's tables out. If some
  // arrived anyway the receiver did not load them, and that is said, not
  // swallowed: it means the other end is not running the code this end is.
  const refusedTables = imported.skipped_tables ?? 0;
  const refusedRows = imported.skipped_rows ?? 0;
  if (refusedTables) console.log(`  ${yellow(WARN)} ${from.label} sent ${refusedTables} table${refusedTables === 1 ? '' : 's'} that belong to its own agent connector. ${refusedTables === 1 ? 'It was' : 'They were'} not loaded on ${to.label}.`);
  if (imported.rows + refusedRows !== exported.rows || imported.tables + refusedTables !== exported.tables) {
    throw new PushError(`${to.label} loaded ${imported.rows} rows in ${imported.tables} tables but ${from.label} sent ${exported.rows} in ${exported.tables}. Nothing was made current.`);
  }

  tick = ticker(`switching ${to.label} to the new database`);
  const swapped = await runOnce(to, 'db_swap', { ...swapArgs, own_option_prefixes: LOCAL_AGENT_OPTIONS, session: sessions.to });
  swapped.kept_admins = (swapped.kept_admins ?? []).map(shown);
  swapped.scrambled = (swapped.scrambled ?? []).map(shown);
  tick.done(`switched; kept this site's own settings and logins (${swapped.kept_admins.join(', ') || 'no administrators'})`);
  // Said here, at the moment it happens, and again in the closing lines of a
  // full copy: an account nobody can log in to is a support call unless the
  // person who ran the push was told why.
  if (swapped.scrambled?.length) console.log(`  ${dim(STEP)} ${dim(`gave ${swapped.scrambled.length} copied account${swapped.scrambled.length === 1 ? '' : 's'} a new random password on ${to.label} (${swapped.scrambled.join(', ')})`)}`);
  return { exported, swapped };
}

async function copyFiles(from, to, sessions, work, roots, mode, { skipLocalOnly = false, refuseCode = false } = {}) {
  let tick = ticker(`comparing files (${roots.join(', ')})`);
  const [a, b] = await Promise.all([
    runSteps(from, 'files_manifest', { session: sessions.from, roots, hash: mode !== 'missing' }, (s) => tick.update(`${from.label} ${s.files_done} of ${s.files}`)),
    runSteps(to, 'files_manifest', { session: sessions.to, roots, hash: mode !== 'missing' }),
  ]);
  const fromList = join(work, 'from-manifest.ndjson');
  const toList = join(work, 'to-manifest.ndjson');
  await from.getFile(sessions.from, 'manifest.ndjson', fromList);
  await to.getFile(sessions.to, 'manifest.ndjson', toList);
  const source = parseManifest(await readFile(fromList, 'utf8'));
  const target = parseManifest(await readFile(toList, 'utf8'));
  // Both lists ride along on the plan: the caller writes down which upload
  // files are now on both ends (see readSeen).
  const plan = { ...diffManifests(skipLocalOnly ? withoutLocalOnlyPlugins(source) : source, target, mode), source, target };
  tick.done(`${a.files} files on ${from.label}, ${b.files} on ${to.label}; ${plan.send.length} to send (${formatBytes(plan.bytes)})`);
  if (!plan.send.length) return plan;

  const want = join(work, 'want.ndjson');
  await writeFile(want, plan.send.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
  await from.putFile(sessions.from, 'want.ndjson', want);
  tick = ticker(`packing ${plan.send.length} file${plan.send.length === 1 ? '' : 's'} on ${from.label}`);
  await runSteps(from, 'files_pack', { session: sessions.from }, (s) => tick.update(`${s.files_done} of ${s.files}`));
  tick.done();
  tick = ticker(`sending files to ${to.label}`);
  await carry(from, sessions.from, to, sessions.to, 'files.pack', work, tick);
  tick.done();
  tick = ticker(`putting files in place on ${to.label}`);
  // roots: the receiver unpacks only what this job asked for. The pack was
  // built by the other site, and before this a pull would have unpacked a
  // `mu-plugins/x.php` the live site slipped in.
  const unpacked = await runSteps(to, 'files_unpack', { session: sessions.to, roots, refuse_code: refuseCode }, (s) => tick.update(`${formatBytes(s.bytes_done)} of ${formatBytes(s.bytes)}`));
  tick.done(`put ${unpacked.written} file${unpacked.written === 1 ? '' : 's'} in place`);
  sayRefused(unpacked, from.label);
  return plan;
}

async function settle(endpoint, session) {
  const tick = ticker(`rebuilding styles and clearing caches on ${endpoint.label}`);
  const css = await runSteps(endpoint, 'rebuild_css', {}, (s) => tick.update(`${s.posts} pages`));
  const finished = await endpoint.run('finish', { session });
  tick.done(`rebuilt styles for ${css.posts} pages; cleared ${finished.cleared.join(', ')}`);
}

/** Two sessions and a scratch folder, always cleaned up - a failed push must not leave a database dump on either end. */
async function withSessions(from, to, fn) {
  const work = await mkdtemp(join(tmpdir(), 'agentpress-push-'));
  const sessions = { from: (await from.run('session_new')).session, to: (await to.run('session_new')).session };
  const cleanUp = async () => {
    await from.run('session_end', { session: sessions.from }).catch(() => {});
    await to.run('session_end', { session: sessions.to }).catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  };
  // Ctrl+C skips `finally`. Without this, stopping a pull halfway left the
  // live site's database export (every user's email and password hash) in
  // its job folder until the plugin's own sweep, and a copy in this
  // machine's temp folder for good.
  const onStop = () => {
    console.log(`\n${yellow(WARN)} Stopped. Removing this job's temporary files on both sites…`);
    cleanUp().finally(() => process.exit(130));
  };
  process.once('SIGINT', onStop);
  try {
    return await fn(sessions, work);
  } finally {
    process.removeListener('SIGINT', onStop);
    await cleanUp();
  }
}

function assertCompatible(local, remote) {
  if (local.plugin_version !== remote.plugin_version || local.format !== remote.format) {
    throw new PushError(
      `The AgentPress Push plugin is ${remote.plugin_version} on ${new URL(remote.site_url).host} and ${local.plugin_version} here. ` +
        (envOn('AGENTPRESS_MENU')
          ? `Pick ${pink(`Set up or reconnect… → ${MENU_LABELS['push plugin']}`)} ${dim('in this menu')}`
          : `Run ${pink('push plugin')}`) +
        ` and upload the new zip on the live site (Plugins ${STEP} Add Plugin ${STEP} Upload Plugin, then "Replace current with uploaded"). Your connection key stays valid. Then try again.`,
    );
  }
}

/* ------------------------------------------------------------ commands -- */

async function connectCommand(site, line) {
  if (!line) throw new PushError(`Usage: ${site.cli} push connect ${pink('<connection line>')}\n  The line comes from Tools > AgentPress Push on the live site.`);
  const conn = parseConnection(line);
  const host = new URL(conn.url).hostname;
  if (new URL(conn.url).protocol !== 'https:' && !isLocalHost(host)) {
    throw new PushError(`${host} is on plain http. A connection key sent over http can be read by anyone on the way, so this refuses. Put the site on https first.`);
  }
  const info = await remoteEndpoint(conn).run('info');
  const envPath = join(site.cwd, '.env');
  await writeFile(envPath, upsertEnv(await readFile(envPath, 'utf8'), { PUSH_REMOTE_URL: conn.url, PUSH_REMOTE_KEY: conn.key }), 'utf8');
  console.log(`${green(OK)} Connected to ${bold(info.name || host)} at ${conn.url}`);
  console.log(`  ${dim(`${STEP} saved the address and key in this site's .env (gitignored)`)}`);
  console.log(`  ${dim(INFO)} WordPress ${info.wp_version}, Oxygen ${info.oxygen_version ?? 'not installed'}, ${info.counts.post} posts, ${info.looks_fresh ? 'looks like a fresh install' : 'already has content'}`);
  console.log(`\n${cyan(STEP)} Next: ${say(site, 'push --full')} for the first copy, or ${say(site, 'pull')} to bring that site down.`);
}

async function pluginCommand(site) {
  const out = join(site.cwd, `${PLUGIN_SLUG}.zip`);
  await writeFile(out, await pluginZip());
  console.log(`${green(OK)} Wrote ${out}`);
  console.log(`${cyan(STEP)} On the live site: Plugins ${STEP} Add Plugin ${STEP} Upload Plugin, choose that file, activate it.`);
  console.log(`  Then Tools ${STEP} AgentPress Push ${STEP} Create a connection key, and run ${say(site, 'push connect', ' <the line it shows>')}`);
}

function requireRemote(site) {
  const url = site.env.PUSH_REMOTE_URL;
  const key = site.env.PUSH_REMOTE_KEY;
  if (!url || !key) {
    throw new PushError(
      `This site is not connected to a live site yet.\n` +
        `  1. ${say(site, 'push plugin')}  ${dim('writes the plugin zip to upload to the live site')}\n` +
        `  2. On the live site: activate it, then Tools ${STEP} AgentPress Push ${STEP} Create a connection key\n` +
        `  3. ${say(site, 'push connect', ' <the line it shows>')}`,
    );
  }
  return remoteEndpoint({ url: url.replace(/\/+$/, ''), key });
}

/**
 * AGENTPRESS_PUSH_TIMING=1 prints how long every call to either end took.
 * Kept in, not a debugging leftover: "the push is slow" is unanswerable
 * without knowing WHICH end and which step, and the person asking is usually
 * looking at a shared host nobody can profile.
 */
function timed(endpoint) {
  if (!envOn('AGENTPRESS_PUSH_TIMING')) return endpoint;
  const wrap = (name) => async (...args) => {
    const started = Date.now();
    try {
      return await endpoint[name](...args);
    } finally {
      const what = name === 'run' ? args[0] : `${name} ${args[1]}`;
      process.stderr.write(`
    [${endpoint.label}] ${what} ${((Date.now() - started) / 1000).toFixed(1)}s
`);
    }
  };
  return { ...endpoint, run: wrap('run'), putFile: wrap('putFile'), getFile: wrap('getFile') };
}

async function bothEnds(site) {
  await ensureLocalPlugin(site.publicDir);
  const local = timed(localEndpoint(site.publicDir));
  const remote = timed(requireRemote(site));
  const tick = ticker('checking both sites');
  const [localInfo, remoteInfoRaw] = await Promise.all([local.run('info'), remote.run('info')]);
  const remoteInfo = shownDeep(remoteInfoRaw);
  tick.done();
  assertCompatible(localInfo, remoteInfo);
  return { local, remote, localInfo, remoteInfo };
}

function designVerdict(localInfo, remoteInfo) {
  if (!localInfo.oxygen_ready || !remoteInfo.oxygen_ready) return 'unknown';
  return localInfo.design_hash === remoteInfo.design_hash ? 'same' : 'different';
}

async function statusCommand(site) {
  const { localInfo, remoteInfo } = await bothEnds(site);
  const row = (label, a, b) => console.log(`  ${label.padEnd(12)} ${String(a).padEnd(30)} ${b}`);
  console.log('');
  row('', bold('local'.padEnd(30)), bold('live'));
  row('address', localInfo.site_url, remoteInfo.site_url);
  row('WordPress', localInfo.wp_version, remoteInfo.wp_version);
  row('Oxygen', localInfo.oxygen_version ?? 'none', remoteInfo.oxygen_version ?? 'none');
  row('posts', localInfo.counts.post, remoteInfo.counts.post);
  row('media', localInfo.counts.attachment, remoteInfo.counts.attachment);
  row('design', `${localInfo.design_items} items`, `${remoteInfo.design_items} items`);
  const verdict = designVerdict(localInfo, remoteInfo);
  console.log('');
  if (verdict === 'same') console.log(`${green(OK)} The design is the same on both. Nothing to push.`);
  else if (verdict === 'different') console.log(`${dim(INFO)} The design differs. ${say(site, 'push --dry-run')} shows what a push would change.`);
  if (remoteInfo.has_undo) console.log(`${dim(INFO)} Live still holds the database from before the last full copy (${say(site, 'push undo --full')}).`);
}

/** First copy: everything local, onto the remote. */
async function pushFull(site, { yes, force, dryRun }) {
  const { local, remote, localInfo, remoteInfo } = await bothEnds(site);
  const host = new URL(remoteInfo.site_url).host;
  console.log(`\n${bold('Full copy')}  ${localInfo.site_url}  ${STEP}  ${remoteInfo.site_url}`);
  console.log(`  Replaces everything on ${host}: its ${remoteInfo.counts.post} posts, ${remoteInfo.counts.page} pages and ${remoteInfo.counts.attachment} media items.`);
  console.log(`  ${dim(`Kept on ${host}: its address, its administrators' logins, its search-engine setting, its Oxygen license.`)}`);
  console.log(`  ${dim('The database it has now is kept beside the new one, so this can be undone.')}`);
  if (dryRun) {
    console.log(`\n${dim(INFO)} Dry run: nothing was sent.`);
    return;
  }
  if (!remoteInfo.looks_fresh) {
    // The one command here that destroys work if aimed at the wrong site.
    // --yes alone must not be enough to do that from a script.
    console.log(`\n${yellow(WARN)} ${host} is not a fresh install. Anything written there since your last pull will be replaced.`);
    if (yes && !force) throw new PushError(`Refusing to replace a site that has content on --yes alone. Add ${pink('--force')} if that is really what you want.`);
    if (!force && !(await confirm(`Type ${host} to replace it`, { expect: host }))) throw new PushError('Nothing was changed.');
  } else if (!(await confirm(`Copy this site to ${host}?`, { yes }))) {
    throw new PushError('Nothing was changed.');
  }
  // Give every design item its permanent id BEFORE the copy, so the ids ride
  // up inside the database and both ends agree on them from the first day.
  if (localInfo.oxygen_ready) await local.run('design_export');
  let copied;
  await withSessions(local, remote, async (sessions, work) => {
    // Files before the database: the copied database says which plugins are
    // active, and WordPress deactivates any whose files it cannot find.
    const files = await copyFiles(local, remote, sessions, work, ['plugins', 'mu-plugins', 'themes', 'uploads'], 'mirror', { skipLocalOnly: true });
    await noteSeen(site, host, files.source.keys(), files.target.keys());
    // drop: the copy's list has the agent plugins switched on, and they must
    // not arrive that way. keep: a target that already ran them itself (a
    // second local site standing in for live) is left as it was.
    // scramble: a dev password must not become a live one (see db_swap).
    copied = await copyDatabase(local, remote, sessions, work, { drop_plugin_dirs: LOCAL_AGENT_PLUGINS, keep_plugin_dirs: LOCAL_AGENT_PLUGINS, scramble_arriving_passwords: true });
    await settle(remote, sessions.to);
  });
  console.log(`\n${green(OK)} ${remoteInfo.site_url} is now a copy of this site.`);
  const scrambled = copied?.swapped?.scrambled ?? [];
  if (scrambled.length) {
    console.log(`${cyan(STEP)} Set a password on ${host} for: ${scrambled.join(', ')}. Passwords from this site were not copied.`);
    console.log(`  ${dim(`In wp-admin there: Users ${STEP} the account ${STEP} Set New Password. Or its owner uses "Lost your password?".`)}`);
  }
  console.log(`${cyan(STEP)} Open it and look. If it is wrong: ${say(site, 'push undo --full')}`);
}

/** Every push after the first: design only. */
async function pushDesign(site, { yes, dryRun }) {
  const { local, remote, localInfo, remoteInfo } = await bothEnds(site);
  const host = new URL(remoteInfo.site_url).host;
  if (!localInfo.oxygen_ready) throw new PushError('Oxygen is not active on this site, so there is no design to push. For a whole-site copy use push --full.');
  if (!remoteInfo.oxygen_ready) throw new PushError(`Oxygen is not active on ${host}. Do the first copy with ${say(site, 'push --full')}.`);
  if (localInfo.oxygen_version !== remoteInfo.oxygen_version) {
    throw new PushError(`Oxygen is ${localInfo.oxygen_version} here and ${remoteInfo.oxygen_version} on ${host}. A design only moves between the same version; update one to match the other.`);
  }
  console.log(`\n${bold('Design push')}  ${localInfo.site_url}  ${STEP}  ${remoteInfo.site_url}`);
  await withSessions(local, remote, async (sessions, work) => {
    let tick = ticker('reading the design here');
    const bundle = await local.run('design_export');
    const file = join(work, 'design.json');
    await writeFile(file, JSON.stringify(bundle), 'utf8');
    await remote.putFile(sessions.to, 'design.json', file);
    tick.done();
    const plan = await remote.run('design_apply', { session: sessions.to, dry: true });
    const lines = describeDesignPlan(plan);
    // Code the design depends on (a must-use plugin registering image sizes,
    // say) is local's and is mirrored. Uploads are live's: only files live
    // does not have yet are added, never one it already holds.
    // Of the themes, only the one this site runs on (see withoutUnusedThemes).
    const code = await copyFilesPlan(local, remote, sessions, work, ['mu-plugins', 'themes'], 'mirror', (list) => withoutUnusedThemes(list, localInfo.themes_in_use));
    const unusedThemes = [...new Set(code.leftOut.map((path) => path.split('/')[1]))];
    const themeLine = unusedThemes.length
      ? `${code.leftOut.length} file${code.leftOut.length === 1 ? '' : 's'} in ${unusedThemes.length === 1 ? 'a theme' : 'themes'} this site does not run on (${unusedThemes.slice(0, 3).map(shown).join(', ')}${unusedThemes.length > 3 ? ', …' : ''})`
      : '';
    // ...and not one live HAD and no longer has: that was deleted there.
    const media = holdBackDeleted(await copyFilesPlan(local, remote, sessions, work, ['uploads'], 'missing'), await readSeen(site.cwd, host));
    const heldLine = media.held.length
      ? `${media.held.length} upload file${media.held.length === 1 ? ' that was' : 's that were'} deleted on ${host} ${media.held.length === 1 ? 'is' : 'are'} left alone (${media.held.slice(0, 2).join(', ')}${media.held.length > 2 ? ', …' : ''})`
      : '';
    if (!lines.length && !code.send.length && !media.send.length) {
      // Nothing visible to change, but if items were only matched by name,
      // record their permanent ids now so the next push does not have to guess again.
      if ((plan.changes ?? []).some((c) => c.action === 'adopt') && !dryRun) await runOnce(remote, 'design_apply', { session: sessions.to });
      console.log(`${green(OK)} ${host} already has this design. Nothing to push.`);
      if (heldLine) console.log(`  ${dim(`${INFO} ${heldLine}`)}`);
      if (themeLine) console.log(`  ${dim(`${INFO} Not sent: ${themeLine}`)}`);
      if (!dryRun) await noteSeen(site, host, media.target.keys());
      return;
    }
    console.log(`\n  On ${host} this will:`);
    for (const line of lines) console.log(`    ${line}`);
    if (code.send.length) console.log(`    ${'send'.padEnd(7)} ${'code'.padEnd(9)} ${code.send.length} file${code.send.length === 1 ? '' : 's'} (${code.send.slice(0, 3).join(', ')}${code.send.length > 3 ? ', …' : ''})`);
    if (media.send.length) console.log(`    ${'send'.padEnd(7)} ${'media'.padEnd(9)} ${media.send.length} file${media.send.length === 1 ? '' : 's'} live does not have (${formatBytes(media.bytes)})`);
    if (heldLine) console.log(`    ${'leave'.padEnd(7)} ${'media'.padEnd(9)} ${heldLine}`);
    if (themeLine) console.log(`    ${'leave'.padEnd(7)} ${'themes'.padEnd(9)} ${themeLine}`);
    console.log(`  ${dim("Stories, users, comments and the editor's own uploads are not touched.")}`);
    if (dryRun) {
      console.log(`\n${dim(INFO)} Dry run: nothing was changed.`);
      return;
    }
    if (!(await confirm(`Push this to ${host}?`, { yes }))) throw new PushError('Nothing was changed.');
    // One pack for both lists: a session holds a single files.pack.
    if (code.send.length || media.send.length) await sendPlanned(local, remote, sessions, work, { send: [...code.send, ...media.send] }, ['mu-plugins', 'themes', 'uploads']);
    tick = ticker(`applying the design on ${host}`);
    const applied = await runOnce(remote, 'design_apply', { session: sessions.to });
    const c = applied.counts;
    tick.done(`applied: ${(c.create ?? 0) + (c.restore ?? 0)} new, ${(c.update ?? 0) + (c.adopt ?? 0)} changed, ${c.bin ?? 0} removed, ${c.same ?? 0} untouched; saved the old design first`);
    await settle(remote, sessions.to);
    await noteSeen(site, host, media.target.keys(), media.send);
    console.log(`\n${green(OK)} ${host} has the new design.`);
    console.log(`${cyan(STEP)} Open it and look. If it is wrong: ${say(site, 'push undo')}`);
  });
}

/** The compare half of copyFiles, so a plan can be shown before anything is sent. */
async function copyFilesPlan(from, to, sessions, work, roots, mode, pick = (list) => list) {
  const tick = ticker(`comparing files (${roots.join(', ')})`);
  // 'missing' only asks "does the other side have this path", so neither end
  // reads a byte of the files: hashing every upload on both ends was most of
  // the wait in a design push, for an answer nothing looked at.
  const hash = mode !== 'missing';
  await Promise.all([runSteps(from, 'files_manifest', { session: sessions.from, roots, hash }), runSteps(to, 'files_manifest', { session: sessions.to, roots, hash })]);
  const a = join(work, `from-${roots[0]}.ndjson`);
  const b = join(work, `to-${roots[0]}.ndjson`);
  await from.getFile(sessions.from, 'manifest.ndjson', a);
  await to.getFile(sessions.to, 'manifest.ndjson', b);
  tick.done();
  const all = parseManifest(await readFile(a, 'utf8'));
  const source = pick(all);
  const target = parseManifest(await readFile(b, 'utf8'));
  // What `pick` took out that would otherwise have travelled: shown in the
  // plan, because a file quietly not sent is a question later.
  const leftOut = source === all ? [] : diffManifests(all, target, mode).send.filter((path) => !source.has(path));
  return { ...diffManifests(source, target, mode), source, target, leftOut };
}

/** A pull leaves out upload files that could run as code. Never silently: a missing file is a question later. */
function sayRefused(unpacked, label) {
  if (!unpacked?.refused) return;
  const names = (unpacked.refused_names ?? []).map(shown);
  console.log(`  ${yellow(WARN)} left out ${unpacked.refused} upload file${unpacked.refused === 1 ? '' : 's'} from ${label} that could run as code (${names.slice(0, 3).join(', ')}${unpacked.refused > 3 ? ', …' : ''}).`);
  console.log(`    ${dim('A pull brings content down, and content is not PHP. If the live site really keeps code under uploads, copy it by hand.')}`);
}

async function sendPlanned(from, to, sessions, work, plan, roots) {
  const want = join(work, 'want.ndjson');
  await writeFile(want, plan.send.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf8');
  await from.putFile(sessions.from, 'want.ndjson', want);
  await runSteps(from, 'files_pack', { session: sessions.from });
  const tick = ticker(`sending ${plan.send.length} file${plan.send.length === 1 ? '' : 's'} to ${to.label}`);
  await carry(from, sessions.from, to, sessions.to, 'files.pack', work, tick);
  const unpacked = await runSteps(to, 'files_unpack', { session: sessions.to, roots });
  tick.done(`put ${unpacked.written} file${unpacked.written === 1 ? '' : 's'} in place`);
}

async function pushUndo(site, { full, yes }) {
  const { remote, remoteInfo } = await bothEnds(site);
  const host = new URL(remoteInfo.site_url).host;
  if (full) {
    if (!remoteInfo.has_undo) throw new PushError(`${host} holds no earlier database to go back to.`);
    if (!(await confirm(`Put ${host} back on the database it had before the last full copy?`, { yes }))) throw new PushError('Nothing was changed.');
    const res = await runOnce(remote, 'db_undo');
    await settle(remote);
    console.log(`${green(OK)} ${host} is back on its earlier database (${res.restored} tables). Files were not rolled back.`);
    return;
  }
  const plan = await remote.run('design_undo', { dry: true });
  const lines = describeDesignPlan(plan);
  if (!lines.length) {
    console.log(`${green(OK)} ${host} already matches its last saved design. Nothing to undo.`);
    return;
  }
  console.log(`\n  Going back to the design saved as ${plan.restored_from} will:`);
  for (const line of lines) console.log(`    ${line}`);
  if (!(await confirm(`Undo the last design push on ${host}?`, { yes }))) throw new PushError('Nothing was changed.');
  await runOnce(remote, 'design_undo');
  await settle(remote);
  console.log(`${green(OK)} ${host} is back on its earlier design.`);
}

/** Pull: live's content, down onto local. */
export async function pullCommand(site, { yes, force, dryRun, positional = [] }) {
  if (positional[1] === 'undo') {
    await ensureLocalPlugin(site.publicDir);
    const local = localEndpoint(site.publicDir);
    const info = await local.run('info');
    if (!info.has_undo) throw new PushError('This site holds no earlier database to go back to.');
    if (!(await confirm('Put this local site back on the database it had before the last pull?', { yes }))) throw new PushError('Nothing was changed.');
    await local.run('db_undo');
    await settle(local);
    console.log(`${green(OK)} This site is back on its earlier database. Uploaded files were not rolled back.`);
    return;
  }
  const { local, remote, localInfo, remoteInfo } = await bothEnds(site);
  const host = new URL(remoteInfo.site_url).host;
  console.log(`\n${bold('Pull')}  ${remoteInfo.site_url}  ${STEP}  ${localInfo.site_url}`);
  console.log(`  Replaces this local site's database with ${host}'s (${remoteInfo.counts.post} posts, ${remoteInfo.counts.attachment} media items) and fetches its uploads.`);
  console.log(`  ${dim("Kept here: this site's .test address, its admin login and its agent (MCP) wiring.")}`);
  // The design lives in the same tables as the stories, so a pull replaces
  // local's design with live's. That loses nothing only when they already
  // match - which is exactly the state a push leaves behind.
  const verdict = designVerdict(localInfo, remoteInfo);
  if (verdict === 'different' && localInfo.design_items > 0) {
    console.log(`\n${yellow(WARN)} The design here is different from the one on ${host}. A pull would replace it with live's.`);
    if (!force) {
      throw new PushError(`Push your design first (${say(site, 'push')}), or add ${pink('--force')} to drop the local design changes.`);
    }
  }
  if (dryRun) {
    console.log(`\n${dim(INFO)} Dry run: nothing was changed.`);
    return;
  }
  if (!(await confirm(`Replace this local site's content with ${host}'s?`, { yes }))) throw new PushError('Nothing was changed.');
  await withSessions(remote, local, async (sessions, work) => {
    // The plugins that ARE the local agent wiring stay on even if the live
    // site has them switched off: without them a pull would leave this site
    // with no MCP endpoint and a 401 nobody could explain.
    // keep_theme: theme files never travel down, so the theme the copy
    // names is not a theme this site has; WordPress would include its
    // functions.php from wherever that option points.
    await copyDatabase(remote, local, sessions, work, { keep_plugin_dirs: LOCAL_AGENT_PLUGINS, keep_theme: true });
    const files = await copyFiles(remote, local, sessions, work, ['uploads'], 'mirror', { refuseCode: true });
    await noteSeen(site, host, files.source.keys());
    await settle(local, sessions.to);
  });
  console.log(`\n${green(OK)} This site now has everything on ${host}.`);
  console.log(`  ${dim(INFO)} The database it had before is kept: ${say(site, 'pull undo')}`);
}

export async function pushCommand(site, { yes, force, dryRun, full, positional = [] }) {
  const sub = positional[1];
  if (sub === 'connect') return connectCommand(site, positional[2]);
  if (sub === 'plugin') return pluginCommand(site);
  if (sub === 'status') return statusCommand(site);
  if (sub === 'undo') return pushUndo(site, { full, yes });
  if (sub) throw new PushError(`Unknown: push ${sub}. Try push, push --full, push status, push undo, push plugin or push connect.`);
  return full ? pushFull(site, { yes, force, dryRun }) : pushDesign(site, { yes, dryRun });
}

/** Shared wrapper: a PushError is a message for the user, anything else is a bug and keeps its stack. */
export async function runPushLike(fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
    if (!(err instanceof PushError)) throw err;
    console.log(`${red(BAD)} ${err.message}`);
    process.exitCode = 1;
    return false;
  }
}
