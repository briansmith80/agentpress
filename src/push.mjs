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
 * The dev site's note of which live site its story notes were taken against
 * (see pushStories). It is an option, so it would ride along in a database
 * copy: up to live, where it means nothing, and away from here in a pull,
 * which replaces the options table. It stays with its own site the same way
 * the agent connector's settings do.
 */
export const LOCAL_STORY_OPTIONS = ['agentpress_push_stories_synced'];
const OWN_OPTIONS = [...LOCAL_AGENT_OPTIONS, ...LOCAL_STORY_OPTIONS];

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
  'push content': 'Push content to live',
  pull: 'Pull content from live',
  'push --full': 'Set up or reconnect… → First launch: full copy to live',
  'push undo': 'Undo… → The last design push',
  'push undo --content': 'Undo… → The last content push',
  'pull undo': 'Undo… → The last pull',
  'push undo --full': 'Undo… → The last full copy',
  'push editor': 'Set up or reconnect… → What editors see on live',
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

/** What a design push would change, as [verb, kind, title]. Everything from the other site goes through shown(). */
export function designChanges(result) {
  const rows = [];
  const label = { create: 'new', restore: 'new', adopt: 'match', update: 'change', bin: 'remove' };
  for (const change of result.changes ?? []) {
    // A match that changes nothing only records which post is which. True, but
    // not something to ask a person to approve seventeen times.
    if (change.action === 'same' || (change.action === 'adopt' && !(change.changed ?? []).length)) continue;
    rows.push([shown(label[change.action] ?? change.action), shown(change.type).replace(/^(oxygen|breakdance)_/, ''), shown(change.title)]);
  }
  for (const [part, verdict] of Object.entries(result.site ?? {})) {
    if (verdict === 'update') rows.push(['change', 'site', shown(part).replace(/_/g, ' ')]);
  }
  return rows;
}

/** The design plan, as lines a person can read before saying yes. */
export function describeDesignPlan(result) {
  return designChanges(result).map(([verb, kind, title]) => `${verb.padEnd(7)} ${kind.padEnd(9)} ${title}`);
}

/**
 * The design plan as a screen: what changes, what is sent, what is left
 * alone, each under its own heading. It used to be one table with all three
 * in it, where "leave themes 393 files in themes this site does not run on
 * (…)" sat in the same column as a footer's name and wrapped in any pane
 * narrower than the sentence (operator, 2026-11-12: "looks like it can be
 * laid out better"). The question a person brings to this screen is "what
 * happens to live?", and the answer has three parts of different weight:
 * the changes are the point, the files follow from them, and the left-alone
 * rows are reassurance, so they are dim.
 *
 * `width` cuts every row on the RAW text, before any colour. Pass nothing
 * when the output is not a terminal: a log file has no window to wrap in.
 */
export function designPlanScreen({ host, changes = [], code = [], media = { count: 0, bytes: 0 }, held = [], themes = { files: 0, names: [] }, width = Infinity }) {
  const fit = (text) => (text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`);
  const row = (a, b, text, paint = (x) => x) => paint(fit(`    ${a.padEnd(8)} ${b.padEnd(10)} ${text}`.trimEnd()));
  const files = (n) => `${n} file${n === 1 ? '' : 's'}`;
  const some = (list, n) => `${list.slice(0, n).join(', ')}${list.length > n ? ', …' : ''}`;
  const lines = [];
  const section = (title) => lines.push('', bold(fit(`  ${title}`)));
  if (changes.length) {
    section(`Changes on ${host}`);
    for (const [verb, kind, title] of changes) lines.push(row(verb, kind, title));
  }
  if (code.length || media.count) {
    section('Files to send');
    if (code.length) lines.push(row('code', files(code.length), some(code, 3)));
    if (media.count) lines.push(row('media', files(media.count), `${formatBytes(media.bytes)}, not on ${host} yet`));
  }
  const anything = changes.length || code.length || media.count;
  if (anything || held.length || themes.files) {
    section('Left alone');
    if (held.length) lines.push(row('media', files(held.length), `deleted on ${host}, so not sent back (${some(held, 2)})`, dim));
    if (themes.files) lines.push(row('themes', files(themes.files), `in ${themes.names.length === 1 ? 'a theme' : 'themes'} this site does not run on (${some(themes.names.map(shown), 3)})`, dim));
    // Only beside a real plan: under "nothing to push" it is a row about nothing.
    if (anything) lines.push(row('content', '', "stories, users, comments and the editor's own uploads", dim));
  }
  return lines;
}

const STORY_STATUS = { publish: 'public', future: 'scheduled', draft: 'draft', pending: 'pending review', private: 'private' };
const STORY_VERB = { create: 'add', update: 'update', restore: 'restore' };
const STORY_LEFT = {
  builder: () => 'built in Oxygen, which this cannot send',
  gone: (host) => `deleted on ${host} after it was sent`,
  binned: (host) => `in the bin on ${host}`,
  on_live: (host) => `${host} has it as its own; change it there`,
  edited: (host) => `edited on ${host} since it was sent`,
  same_address: (host) => `${host} already has a story at that address`,
  image_clash: (host, e) => `${host} has a different file called ${shown(e.notes?.[0] ?? 'the same name')}`,
  image_bad: (host, e) => `an image has a name that cannot travel (${shown(e.notes?.[0] ?? '?')})`,
};
const STORY_FAILED = { image_missing: 'an image did not arrive', insert: 'WordPress refused it', update: 'WordPress refused the change' };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const storyCount = (n) => plural(n, 'story', 'stories');
const storyTitle = (title) => {
  const text = shown(title) || '(no title)';
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

/**
 * The receiver's plan for a set of stories, as a screen. Laid out like the
 * design preview (see designPlanScreen) so the two read as one tool: what
 * will be sent under one bold heading, what is left alone, dim, under
 * another. Stories that will travel are numbered (the number is what the
 * "send which?" question takes) and come back in `sendable`, in that order.
 * One left alone always says why: a story quietly not sent is a question later.
 *
 * `width` cuts every row on the RAW text, before any colour.
 */
export function describeStoryPlan(entries, host, width = Infinity) {
  const fit = (text, max = width) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);
  const all = entries ?? [];
  const sendable = all.filter((e) => e.action !== 'leave');
  const left = all.filter((e) => e.action === 'leave');
  const REST = 'everything else';
  // Titles share one column so the second column starts in one place. A title
  // longer than the cap pushes only its own row out.
  const wide = Math.min(40, Math.max(REST.length, ...all.map((e) => storyTitle(e.title).length)));
  const lines = [];
  const section = (title) => lines.push('', bold(fit(`  ${title}`)));
  // A plain head and a dim tail, cut as ONE raw line and coloured afterwards.
  const row = (head, tail, paint = (x) => x) => {
    const h = fit(head);
    // No tail at all when there is not room for two characters of it: a lone … is noise, and a third column over.
    const t = tail && width - h.length - 2 >= 2 ? fit(tail, width - h.length - 2) : '';
    return `${paint(h)}${t ? `  ${dim(t)}` : ''}`;
  };
  if (sendable.length) {
    section(`Stories to send to ${host}`);
    // Notes sit under the title they belong to: 4 indent, 2 number, 2 gap, verb and its space.
    const under = ' '.repeat(4 + 2 + 2 + 9);
    const note = (text) => lines.push(`${under}${dim(fit(text, width - under.length))}`);
    sendable.forEach((e, i) => {
      const bits = [STORY_STATUS[e.status] ?? shown(e.status)];
      if (e.images) bits.push(plural(e.images, 'image'));
      if (e.files?.length) bits.push(`${plural(e.files.length, 'file')} to send`);
      lines.push(row(`    ${String(i + 1).padStart(2)}  ${(STORY_VERB[e.action] ?? shown(e.action)).padEnd(8)} ${storyTitle(e.title).padEnd(wide)}`, bits.join(', ')));
      if (e.new_terms?.length) note(`makes ${e.new_terms.length === 1 ? 'the category or tag' : 'the categories or tags'} ${e.new_terms.map(shown).join(', ')}`);
      for (const raw of e.notes ?? []) {
        const [kind, a, b] = shown(raw).split(':');
        const standIn = b || 'the first administrator';
        if (kind === 'author') note(a ? `its author ${a} has no account on ${host}; it goes up as ${standIn}` : `it has no author here; it goes up as ${standIn}`);
        if (kind === 'no_taxonomy') note(`${host} has no "${a}" grouping, so that part is left off`);
      }
    });
  }
  if (left.length || sendable.length) {
    section('Left alone');
    // Under a list of stories to send, the reasons start where the statuses
    // above them do (a number, a gap and a verb further in), so the screen has
    // two columns, not three.
    const cell = wide + (sendable.length ? 13 : 0);
    for (const e of left) lines.push(row(`    ${storyTitle(e.title).padEnd(cell)}`, (STORY_LEFT[e.reason] ?? (() => shown(e.reason)))(host, e), dim));
    // Only beside a real plan: with nothing to send it is a row about nothing.
    if (sendable.length) lines.push(row(`    ${REST.padEnd(cell)}`, `this only adds: nothing on ${host} is replaced or deleted`, dim));
  }
  return { lines, sendable };
}

/**
 * The answer to "send which?": nothing or `all` is every one, otherwise
 * numbers from the list. Anything else is null, and the caller sends
 * nothing: a typo must not be read as "all".
 */
export function pickStories(answer, count) {
  const text = String(answer).trim().toLowerCase();
  if (text === '' || text === 'a' || text === 'all') return Array.from({ length: count }, (_, i) => i);
  if (!/^\d+([\s,]+\d+)*$/.test(text)) return null;
  const picked = [...new Set(text.split(/[\s,]+/).map(Number))];
  return picked.every((n) => n >= 1 && n <= count) ? picked.map((n) => n - 1).sort((a, b) => a - b) : null;
}

/** -1, 0, 1 for two dotted versions, or null when either is not one (`6.2.0-beta.3` against `6.2.0`). */
export function compareVersions(a, b) {
  const parse = (v) => (/^\d+(\.\d+)*$/.test(String(v)) ? String(v).split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Where the two sites' plugins are not the same, for `push status`. Only
 * differences come back: a list of forty matching plugins is forty lines
 * nobody reads, with the two that matter somewhere inside.
 *
 * Left out on purpose: the agent plugins (local-only by design, so "missing
 * on live" is the correct state, not a finding) and this tool's own plugin
 * (both ends are refused unless it matches).
 */
export function comparePlugins(localList, liveList) {
  const mine = (list) => new Map((Array.isArray(list) ? list : []).filter((pl) => pl && !LOCAL_AGENT_PLUGINS.includes(pl.dir) && pl.dir !== PLUGIN_SLUG).map((pl) => [pl.dir, pl]));
  const here = mine(localList);
  const there = mine(liveList);
  const cell = (pl) => (pl ? `${pl.version || '?'}${pl.active ? '' : ' (off)'}` : 'not installed');
  const rows = [];
  for (const dir of [...new Set([...here.keys(), ...there.keys()])].sort()) {
    const a = here.get(dir);
    const b = there.get(dir);
    if (a && b && a.version === b.version && a.active === b.active) continue;
    const order = a && b ? compareVersions(a.version, b.version) : null;
    rows.push({ name: (a ?? b).name || dir, local: cell(a), live: cell(b), newer: order === -1 ? 'live' : order === 1 ? 'local' : null });
  }
  const live = [...there.values()];
  return {
    rows,
    auto: live.filter((pl) => pl.auto).map((pl) => pl.name),
    waiting: live.filter((pl) => pl.update).map((pl) => `${pl.name} ${pl.version} ${STEP} ${pl.update}`),
  };
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

/**
 * `████████░░░░░░░░░░  42%` for a step that knows how far along it is. Plain
 * characters, no colour of its own: the caller dims the empty part. Width is
 * fixed so the numbers after it do not jitter as it fills.
 */
export function progressBar(done, total, width = 18) {
  if (!(Number(total) > 0)) return null;
  const ratio = Math.max(0, Math.min(1, Number(done) / Number(total)));
  const full = Math.round(ratio * width);
  return { full: '█'.repeat(full), empty: '░'.repeat(width - full), percent: `${String(Math.round(ratio * 100)).padStart(3)}%` };
}

/**
 * One status line that rewrites itself, then leaves a past-tense receipt.
 * `progress(done, total, note)` draws a bar (operator's ask, 2026-11-12: a
 * full copy sat on "sending files" with a byte count and no sense of how
 * much was left); `update(note)` is for a step with no total.
 *
 * The line is cut to the window, on the raw text: `\r` plus erase-line only
 * clears ONE row, so a line that wraps leaves its first half behind on every
 * repaint. Same failure as the chooser's rows (see CLAUDE.md), found there.
 */
function ticker(text) {
  const live = process.stdout.isTTY;
  const fit = (raw, max) => (raw.length <= max ? raw : max < 2 ? '' : `${raw.slice(0, max - 1)}…`);
  const paint = (bar, note) => {
    if (!live) return;
    const room = Math.max(20, (process.stdout.columns || 80) - 1);
    const head = fit(`  … ${text}`, room);
    let left = room - head.length;
    let out = head;
    if (bar && left >= bar.full.length + bar.empty.length + bar.percent.length + 4) {
      out += `  ${bar.full}${dim(bar.empty)} ${bar.percent}`;
      left -= bar.full.length + bar.empty.length + bar.percent.length + 3;
    }
    const tail = note ? fit(note, left - 2) : '';
    if (tail) out += `  ${dim(tail)}`;
    process.stdout.write(`\r\x1b[2K${out}`);
  };
  if (live) paint(null, '');
  else console.log(`  … ${text}`);
  return {
    update: (note) => paint(null, note),
    progress: (done, total, note) => paint(progressBar(done, total), note),
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

/** A question with a typed answer. Not a terminal: the answer is null, which every caller reads as "no". */
async function ask(question) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`? ${question}: `)).trim();
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
  await from.getFile(fromSession, name, path, (done, total) => tick?.progress(done, total, `down ${formatBytes(done)} of ${formatBytes(total)}`));
  await to.putFile(toSession, name, path, (done, total) => tick?.progress(done, total, `up ${formatBytes(done)} of ${formatBytes(total)}`));
  const { size } = await stat(path);
  await rm(path, { force: true });
  return size;
}

async function copyDatabase(from, to, sessions, work, swapArgs = {}) {
  let tick = ticker(`reading the database on ${from.label}`);
  const exported = await runSteps(from, 'db_export', { session: sessions.from, own_tables: LOCAL_AGENT_TABLES }, (s) => tick.progress(s.tables_done, s.tables, `table ${s.tables_done} of ${s.tables}`));
  tick.done(`read ${exported.rows} rows from ${exported.tables} tables (${formatBytes(exported.bytes)})`);

  tick = ticker(`sending the database to ${to.label}`);
  await carry(from, sessions.from, to, sessions.to, 'db.ndjson', work, tick);
  tick.done();

  tick = ticker(`loading it beside the current one on ${to.label}`);
  const imported = await runSteps(to, 'db_import', { session: sessions.to, own_tables: LOCAL_AGENT_TABLES }, (s) => tick.progress(s.bytes_done, s.bytes, `${formatBytes(s.bytes_done)} of ${formatBytes(s.bytes)}`));
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
  const swapped = await runOnce(to, 'db_swap', { ...swapArgs, own_option_prefixes: OWN_OPTIONS, session: sessions.to });
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
    runSteps(from, 'files_manifest', { session: sessions.from, roots, hash: mode !== 'missing' }, (s) => tick.progress(s.files_done, s.files, `${from.label} ${s.files_done} of ${s.files}`)),
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
  await runSteps(from, 'files_pack', { session: sessions.from }, (s) => tick.progress(s.files_done, s.files, `${s.files_done} of ${s.files}`));
  tick.done();
  tick = ticker(`sending files to ${to.label}`);
  await carry(from, sessions.from, to, sessions.to, 'files.pack', work, tick);
  tick.done();
  tick = ticker(`putting files in place on ${to.label}`);
  // roots: the receiver unpacks only what this job asked for. The pack was
  // built by the other site, and before this a pull would have unpacked a
  // `mu-plugins/x.php` the live site slipped in.
  const unpacked = await runSteps(to, 'files_unpack', { session: sessions.to, roots, refuse_code: refuseCode }, (s) => tick.progress(s.bytes_done, s.bytes, `${formatBytes(s.bytes_done)} of ${formatBytes(s.bytes)}`));
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
  // Pad the RAW text, then colour: a differing row's live value is the one thing on this screen that is not dim-or-plain.
  const row = (label, a, b, differs = false) => console.log(`  ${label.padEnd(12)} ${String(a).padEnd(30)} ${String(b)}${differs ? `  ${dim('differs')}` : ''}`);
  const version = (label, a, b) => row(label, a ?? 'none', b ?? 'none', (a ?? '') !== (b ?? ''));
  console.log('');
  row('', bold('local'.padEnd(30)), bold('live'));
  row('address', localInfo.site_url, remoteInfo.site_url);
  version('WordPress', localInfo.wp_version, remoteInfo.wp_version);
  version('PHP', localInfo.php_version, remoteInfo.php_version);
  version('Oxygen', localInfo.oxygen_version, remoteInfo.oxygen_version);
  row('posts', localInfo.counts.post, remoteInfo.counts.post);
  row('pages', localInfo.counts.page, remoteInfo.counts.page);
  row('media', localInfo.counts.attachment, remoteInfo.counts.attachment);
  row('design', `${localInfo.design_items} items`, `${remoteInfo.design_items} items`);
  const seen = (info) => (info.search_visible ? 'shown to search engines' : 'hidden from search engines');
  row('search', seen(localInfo), seen(remoteInfo));

  const plugins = comparePlugins(localInfo.plugins, remoteInfo.plugins);
  if (plugins.rows.length) {
    console.log(`\n  ${bold('Plugins that differ')}`);
    const cut = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
    for (const pl of plugins.rows) console.log(`  ${cut(pl.name, 28).padEnd(29)}${pl.local.padEnd(18)}${pl.live}${pl.newer ? `  ${dim(`newer ${pl.newer === 'live' ? 'on live' : 'here'}`)}` : ''}`);
  }

  const verdict = designVerdict(localInfo, remoteInfo);
  console.log('');
  if (verdict === 'same') console.log(`${green(OK)} The design is the same on both. Nothing to push.`);
  else if (verdict === 'different') console.log(`${dim(INFO)} The design differs. ${say(site, 'push --dry-run')} shows what a push would change.`);
  // A real warning: a design push is refused until these match.
  if (localInfo.oxygen_version && remoteInfo.oxygen_version && localInfo.oxygen_version !== remoteInfo.oxygen_version) {
    console.log(`${yellow(WARN)} Oxygen is ${localInfo.oxygen_version} here and ${remoteInfo.oxygen_version} on live. A design only moves between the same version.`);
  }
  const ahead = plugins.rows.filter((pl) => pl.newer === 'live').map((pl) => pl.name);
  if (ahead.length) console.log(`${cyan(STEP)} Newer on live: ${ahead.join(', ')}. Update ${ahead.length === 1 ? 'it' : 'them'} here (wp-admin ${STEP} Plugins) so you build against what live runs.`);
  if (plugins.auto.length) console.log(`${dim(INFO)} Live updates ${plugins.auto.length === 1 ? 'this plugin' : `these ${plugins.auto.length} plugins`} by itself: ${plugins.auto.join(', ')}.`);
  if (plugins.waiting.length) console.log(`${dim(INFO)} Updates waiting on live: ${plugins.waiting.join(', ')}.`);
  // Live's only, not a row: this end is read through the command line, whose
  // PHP has no memory limit and its own upload size, so a "local" column
  // here printed `-1` and `16 MB` for a site whose web server allows neither
  // (first run of this screen, 2026-11-12).
  const limits = [
    remoteInfo.upload_max_bytes ? `uploads up to ${formatBytes(remoteInfo.upload_max_bytes)}` : '',
    remoteInfo.memory_limit ? (remoteInfo.memory_limit === '-1' ? 'no PHP memory limit' : `PHP memory ${shown(remoteInfo.memory_limit)}`) : '',
  ].filter(Boolean);
  if (limits.length) console.log(`${dim(INFO)} Live allows ${limits.join(', ')}.`);
  if (Array.isArray(remoteInfo.editor_hidden)) {
    // The names wp-admin uses, as the list itself prints them. The first run on the real server said "News".
    const names = remoteInfo.editor_hidden.map((key) => EDITOR_LABELS[key] ?? shown(key));
    console.log(names.length ? `${dim(INFO)} Editors on live do not see: ${names.join(', ')}. To change that: ${say(site, 'push editor')}` : `${dim(INFO)} Editors on live see everything an editor can, Pages included, and a design push replaces a page built in Oxygen. To hide things: ${say(site, 'push editor')}`);
  }
  if (remoteInfo.has_undo) console.log(`${dim(INFO)} Live still holds the database from before the last full copy (${say(site, 'push undo --full')}).`);
  // Only once the notes were taken against THIS live site does "no note"
  // mean "written here". Before that every story would count.
  if (localInfo.stories_synced_with === new URL(remoteInfo.site_url).host && localInfo.stories_unsent > 0) {
    console.log(`${dim(INFO)} ${storyCount(localInfo.stories_unsent)} written here ${localInfo.stories_unsent === 1 ? 'is' : 'are'} not on live. ${say(site, 'push content')} sends ${localInfo.stories_unsent === 1 ? 'it' : 'them'}.`);
  }
}

/**
 * The stories on this site that could go up, worked out WITHOUT writing a
 * note anywhere: what a dry run and a pull's warning ask. When the notes
 * were never taken against this live site the answer needs its list of
 * stories (see stories_level in the plugin).
 */
async function storiesWaiting(local, remote, localInfo, host, only = []) {
  const args = { only };
  if (localInfo.stories_synced_with !== host) {
    args.index = (await remote.run('stories_index')).stories;
    args.mark = host;
  }
  return local.run('stories_export', args);
}

/**
 * Stories written here, up to live. The one way UP for content, for the one
 * case the ownership rule had no answer to: the AI agent only works on the
 * dev site (that is the point of keeping its plugins off the live one), so
 * what it writes is born on the wrong side. Before this those stories had
 * nowhere to go: a design push ignores them, a full copy would replace the
 * editor's work to deliver them, and the next pull deleted them.
 *
 * It only ever ADDS. A story live already has is the editor's and is left
 * alone, with one exception: one this command sent that nobody there has
 * touched since. Everything is decided by the receiver, twice: once for the
 * plan a person reads, and again from scratch when it acts.
 */
async function pushStories(site, { yes, dryRun, draft, positional = [] }) {
  const { local, remote, localInfo, remoteInfo } = await bothEnds(site);
  const host = new URL(remoteInfo.site_url).host;
  const only = positional.slice(2).map(String);
  console.log(`\n${bold('Push content')}  ${localInfo.site_url}  ${STEP}  ${remoteInfo.site_url}`);
  // First time against this live site: note which stories it already has.
  // Not on a dry run, which writes nothing, the notes included.
  if (localInfo.stories_synced_with !== host && !dryRun) {
    const tick = ticker(`checking which stories ${host} already has`);
    const index = (await remote.run('stories_index')).stories;
    const levelled = await local.run('stories_level', { mark: host, index });
    tick.done(`noted ${storyCount(levelled.noted)} here that ${host} already has`);
    localInfo.stories_synced_with = host;
  }
  const bundle = await storiesWaiting(local, remote, localInfo, host, only);
  if (bundle.unknown?.length) throw new PushError(`No story here has the number or slug ${bundle.unknown.map(shown).join(', ')}.`);
  for (const title of bundle.on_live ?? []) console.log(`  ${dim(`${INFO} ${storyTitle(title)}: ${STORY_LEFT.on_live(host)}`)}`);
  if (!bundle.items.length) {
    console.log(`${green(OK)} ${only.length ? 'Nothing there to send.' : `Every story here is already on ${host}. Nothing to send.`}`);
    return;
  }
  if (bundle.items.length > 50) throw new PushError(`${storyCount(bundle.items.length)} are waiting. Send up to 50 at a time: name them by number or slug after ${pink('push content')}.`);
  await withSessions(local, remote, async (sessions, work) => {
    const file = join(work, 'stories.json');
    await writeFile(file, JSON.stringify(bundle), 'utf8');
    await remote.putFile(sessions.to, 'stories.json', file);
    const planned = await remote.run('stories_import', { session: sessions.to, dry: true, draft });
    const { lines, sendable } = describeStoryPlan(planned.plan, host, process.stdout.isTTY ? Math.max(40, (process.stdout.columns || 100) - 1) : Infinity);
    for (const line of lines) console.log(line);
    if (!sendable.length) {
      console.log(`\n${dim(INFO)} Nothing can be sent as things stand.`);
      return;
    }
    if (dryRun) {
      console.log(`\n${dim(INFO)} Preview only: nothing was sent or changed.`);
      console.log(`${cyan(STEP)} To send ${sendable.length === 1 ? 'it' : 'them'}: ${say(site, 'push content')}`);
      return;
    }
    console.log('');
    let chosen = sendable;
    let asDrafts = draft;
    if (!yes) {
      if (sendable.length > 1) {
        const picked = pickStories((await ask(`Send which? Enter for all ${sendable.length}, or numbers like 1,3`)) ?? 'none', sendable.length);
        if (!picked?.length) throw new PushError('Nothing was sent.');
        chosen = picked.map((i) => sendable[i]);
      }
      // The one thing here a person cannot take back by thinking again: a
      // public story is public the second it lands. Named, then asked.
      const goingPublic = asDrafts ? [] : chosen.filter((e) => e.status === 'publish');
      if (goingPublic.length) {
        console.log(`\n  ${goingPublic.length === 1 ? 'This one is' : `These ${goingPublic.length} are`} public on ${host} the moment ${goingPublic.length === 1 ? 'it arrives' : 'they arrive'}:`);
        for (const e of goingPublic) console.log(`    ${storyTitle(e.title)}`);
        const answer = ((await ask(`Send ${storyCount(chosen.length)} to ${host}? [y/N/d] ${dim('(d = send as drafts instead)')}`)) ?? '').toLowerCase();
        if (/^d(rafts?)?$/.test(answer)) asDrafts = true;
        else if (!/^y(es)?$/.test(answer)) throw new PushError('Nothing was sent.');
      } else if (!(await confirm(`Send ${storyCount(chosen.length)} to ${host}${asDrafts ? ' as drafts' : ''}?`))) {
        throw new PushError('Nothing was sent.');
      }
    }
    const files = [...new Set(chosen.flatMap((e) => e.files ?? []))];
    if (files.length) await sendPlanned(local, remote, sessions, work, { send: files }, ['uploads']);
    const tick = ticker(`adding ${storyCount(chosen.length)} on ${host}`);
    const done = await runOnce(remote, 'stories_import', { session: sessions.to, draft: asDrafts, only: chosen.map((e) => e.uid) });
    // The note on this site is written only now, from what live says it has.
    if (done.sent?.length) await local.run('stories_mark', { sent: done.sent });
    const finished = await remote.run('finish', { session: sessions.to });
    tick.done(`cleared ${finished.cleared.join(', ')}`);
    // Those files are on both ends now: if the editor deletes one there, a
    // design push must not offer it back (see readSeen).
    if (files.length) await noteSeen(site, host, files);
    console.log('');
    let failed = 0;
    for (const e of done.plan ?? []) {
      if (e.action === 'failed') {
        failed++;
        console.log(`${red(BAD)} ${storyTitle(e.title)}: not sent, ${STORY_FAILED[e.reason] ?? shown(e.reason)}.`);
      } else if (e.action === 'leave') {
        // Planned a moment ago, refused now: live changed in between.
        console.log(`${yellow(WARN)} ${storyTitle(e.title)}: left alone, ${(STORY_LEFT[e.reason] ?? (() => shown(e.reason)))(host, e)}.`);
      } else {
        console.log(`${green(OK)} ${storyTitle(e.title)}  ${dim(`${STORY_STATUS[e.status] ?? shown(e.status)}  ${shown(e.url ?? '')}`)}`);
      }
    }
    if (failed) process.exitCode = 1;
    if (done.undo) console.log(`${cyan(STEP)} Open ${done.sent.length === 1 ? 'it' : 'them'} and look. To take ${done.sent.length === 1 ? 'it' : 'them'} back: ${say(site, 'push undo --content')}`);
  });
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
    // Every story here is on live now, and is live's from here on.
    await local.run('stories_level', { mark: host });
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
    // ...and not one live HAD and no longer has: that was deleted there.
    const media = holdBackDeleted(await copyFilesPlan(local, remote, sessions, work, ['uploads'], 'missing'), await readSeen(site.cwd, host));
    const screen = designPlanScreen({
      host,
      changes: designChanges(plan),
      code: code.send,
      media: { count: media.send.length, bytes: media.bytes },
      held: media.held,
      themes: { files: code.leftOut.length, names: unusedThemes },
      width: process.stdout.isTTY ? Math.max(40, (process.stdout.columns || 100) - 1) : Infinity,
    });
    if (!lines.length && !code.send.length && !media.send.length) {
      // Nothing visible to change, but if items were only matched by name,
      // record their permanent ids now so the next push does not have to guess again.
      if ((plan.changes ?? []).some((c) => c.action === 'adopt') && !dryRun) await runOnce(remote, 'design_apply', { session: sessions.to });
      console.log(`\n${green(OK)} ${host} already has this design. Nothing to push.`);
      for (const line of screen) console.log(line);
      if (!dryRun) await noteSeen(site, host, media.target.keys());
      return;
    }
    for (const line of screen) console.log(line);
    if (dryRun) {
      console.log(`\n${dim(INFO)} Preview only: nothing was sent or changed.`);
      console.log(`${cyan(STEP)} To send it: ${say(site, 'push')}`);
      return;
    }
    console.log('');
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
  const tick = ticker(`sending ${plan.send.length} file${plan.send.length === 1 ? '' : 's'} to ${to.label}`);
  await runSteps(from, 'files_pack', { session: sessions.from }, (s) => tick.progress(s.files_done, s.files, `packing ${s.files_done} of ${s.files}`));
  await carry(from, sessions.from, to, sessions.to, 'files.pack', work, tick);
  const unpacked = await runSteps(to, 'files_unpack', { session: sessions.to, roots }, (s) => tick.progress(s.bytes_done, s.bytes, `putting in place ${formatBytes(s.bytes_done)} of ${formatBytes(s.bytes)}`));
  tick.done(`put ${unpacked.written} file${unpacked.written === 1 ? '' : 's'} in place`);
}

async function pushUndo(site, { full, content, yes }) {
  const { local, remote, remoteInfo } = await bothEnds(site);
  const host = new URL(remoteInfo.site_url).host;
  if (content) {
    const plan = await remote.run('stories_undo', { dry: true });
    const binned = (plan.binned ?? []).map(storyTitle);
    const reverted = (plan.reverted ?? []).map(storyTitle);
    if (!binned.length && !reverted.length) {
      console.log(`${green(OK)} The stories last sent to ${host} are already gone from it. Nothing to take back.`);
      return;
    }
    console.log(`\n  Taking back the stories last sent to ${host} will:`);
    for (const title of binned) console.log(`    ${'bin'.padEnd(8)} ${title}`);
    for (const title of reverted) console.log(`    ${'restore'.padEnd(8)} ${title}  ${dim('the text it had before')}`);
    console.log(`  ${dim(`They go to the bin on ${host}, not deleted. Images stay in its media library. Nothing changes on this site.`)}`);
    if (!(await confirm(`Take ${binned.length + reverted.length === 1 ? 'it' : 'them'} back on ${host}?`, { yes }))) throw new PushError('Nothing was changed.');
    const res = await runOnce(remote, 'stories_undo');
    // Here they are stories written here again, so they can be sent again.
    await local.run('stories_mark', { unsent: res.uids ?? [], changed: res.reverted_uids ?? [] });
    await remote.run('finish');
    console.log(`${green(OK)} Took back ${storyCount((res.binned ?? []).length + (res.reverted ?? []).length)} on ${host}.`);
    return;
  }
  if (full) {
    if (!remoteInfo.has_undo) throw new PushError(`${host} holds no earlier database to go back to.`);
    if (!(await confirm(`Put ${host} back on the database it had before the last full copy?`, { yes }))) throw new PushError('Nothing was changed.');
    const res = await runOnce(remote, 'db_undo');
    await settle(remote);
    // Live's stories are the earlier set again, so the notes taken at the
    // full copy ("live has every story here") are wrong. Take them afresh.
    await local.run('stories_level', { mark: host, index: (await remote.run('stories_index')).stories, reset: true });
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
  // A pull replaces the database, and stories written here live in it. Before
  // this check they were deleted without a word (found by reading, 2026-11-12).
  const waiting = (await storiesWaiting(local, remote, localInfo, host)).items;
  if (waiting.length) {
    console.log(`\n${yellow(WARN)} ${storyCount(waiting.length)} here ${waiting.length === 1 ? 'is' : 'are'} not on ${host}, and a pull would delete ${waiting.length === 1 ? 'it' : 'them'}:`);
    for (const item of waiting.slice(0, 8)) console.log(`    ${storyTitle(item.post_title)}  ${dim(item.fresh ? 'written here' : 'changed here since it was sent')}`);
    if (waiting.length > 8) console.log(`    ${dim(`and ${waiting.length - 8} more`)}`);
    if (!force) throw new PushError(`Send ${waiting.length === 1 ? 'it' : 'them'} first (${say(site, 'push content')}), or add ${pink('--force')} to drop ${waiting.length === 1 ? 'it' : 'them'}.`);
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
    // Every story here came from live a moment ago.
    await local.run('stories_level', { mark: host });
    await settle(local, sessions.to);
  });
  console.log(`\n${green(OK)} This site now has everything on ${host}.`);
  console.log(`  ${dim(INFO)} The database it had before is kept: ${say(site, 'pull undo')}`);
}

export async function pushCommand(site, { yes, force, dryRun, full, draft, content, positional = [] }) {
  const sub = positional[1];
  if (sub === 'connect') return connectCommand(site, positional[2]);
  if (sub === 'plugin') return pluginCommand(site);
  if (sub === 'status') return statusCommand(site);
  if (sub === 'undo') return pushUndo(site, { full, content, yes });
  if (sub === 'editor') return editorCommand(site, positional[2], positional.slice(3), { yes });
  if (sub === 'pages') return pagesCommand(site, positional[2], { yes });
  // `content` is the name, to sit beside "Pull content" (operator's call,
  // 2026-11-12). What it sends is stories, so the older words still work.
  if (sub === 'content' || sub === 'stories' || sub === 'posts') return pushStories(site, { yes, dryRun, draft, positional });
  if (sub) throw new PushError(`Unknown: push ${sub}. Try push, push content, push --full, push status, push editor, push undo, push plugin or push connect.`);
  return full ? pushFull(site, { yes, force, dryRun }) : pushDesign(site, { yes, dryRun });
}

/** The plugin's keys as wp-admin names them, for a line that has no list from the live site to read them off. */
const EDITOR_LABELS = { pages: 'Pages', comments: 'Comments', tools: 'Tools', news: 'WordPress news' };

/** What each thing an editor can be kept from seeing is, in a few words. Keys are the plugin's. */
const EDITOR_NOTES = {
  pages: 'hidden = locked: only administrators edit pages',
  comments: 'the Comments screen and the toolbar bubble',
  tools: 'the Tools menu',
  news: 'the news box on the dashboard and the W menu',
};

/** The list `push editor` shows, numbered: the number is what "Switch which?" takes. */
export function editorViewScreen(items, host, width = Infinity) {
  const fit = (text, max = width) => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`);
  const wide = Math.max(...items.map((item) => shown(item.label).length));
  const lines = ['', bold(fit(`  What editors see on ${host}`))];
  items.forEach((item, i) => {
    const head = fit(`    ${String(i + 1).padStart(2)}  ${shown(item.label).padEnd(wide)}  ${(item.hidden ? 'hidden' : 'shown').padEnd(6)}`);
    const note = EDITOR_NOTES[item.key] ?? '';
    const tail = note && width - head.length - 2 >= 2 ? fit(note, width - head.length - 2) : '';
    lines.push(`${head}${tail ? `  ${dim(tail)}` : ''}`);
  });
  lines.push('', dim(fit('  Administrators always see everything. Posts, Media and Profile stay: they are the job.')));
  lines.push(dim(fit('  Appearance, Plugins, Users, Settings and Oxygen never show for an editor.')));
  return lines;
}

/** "2,3" as row numbers to flip. Enter flips NOTHING (unlike "send which?", where Enter is all); a typo is null. */
export function pickSwitches(answer, count) {
  return String(answer).trim() === '' ? [] : /^(a|all)$/i.test(String(answer).trim()) ? null : pickStories(answer, count);
}

/**
 * What people who are not administrators are shown in the live site's
 * wp-admin. Pages is a real lock (see pagesCommand's old note below); the
 * rest tidies the menu for a client who writes stories and needs nothing
 * else. With no action it shows the list and, at a terminal, asks which to
 * flip, so the site menu can offer it as one item.
 */
async function editorCommand(site, action, keys, { yes } = {}) {
  if (action && action !== 'hide' && action !== 'show') throw new PushError(`Unknown: push editor ${shown(action)}. Use push editor, push editor hide <what> or push editor show <what>.`);
  const wanted = keys.map((key) => String(key).toLowerCase());
  if (action && !wanted.length) throw new PushError(`Say what to ${action}: ${Object.keys(EDITOR_NOTES).join(', ')}.`);
  const { remote, remoteInfo } = await bothEnds(site);
  const host = new URL(remoteInfo.site_url).host;
  const width = process.stdout.isTTY ? Math.max(40, (process.stdout.columns || 100) - 1) : Infinity;
  const said = (items, keysChanged) =>
    items
      .filter((item) => keysChanged.includes(item.key))
      .map((item) => `${shown(item.label)} ${item.hidden ? 'hidden' : 'shown'}`)
      .join(', ');
  let state = await remote.run('editor_view', action ? { [action]: wanted } : {});
  for (const line of editorViewScreen(state.items, host, width)) console.log(line);
  if (action) {
    console.log(`\n${green(OK)} On ${host}: ${said(state.items, wanted)}.`);
    return;
  }
  if (yes || !process.stdin.isTTY) return;
  console.log('');
  const picked = pickSwitches((await ask('Switch which? Numbers like 2,3 flip them. Enter changes nothing')) ?? '', state.items.length);
  if (picked === null) throw new PushError('Nothing was changed.');
  if (!picked.length) {
    console.log(`${dim(INFO)} Nothing was changed.`);
    return;
  }
  const flip = picked.map((i) => state.items[i]);
  state = await remote.run('editor_view', { hide: flip.filter((item) => !item.hidden).map((item) => item.key), show: flip.filter((item) => item.hidden).map((item) => item.key) });
  for (const line of editorViewScreen(state.items, host, width)) console.log(line);
  console.log(`\n${green(OK)} On ${host}: ${said(state.items, flip.map((item) => item.key))}.`);
}

/** `push pages`, kept from 0.1.10: Pages alone, by its old words. The same switch as `push editor hide pages`. */
async function pagesCommand(site, action, options) {
  if (action && action !== 'open' && action !== 'lock') throw new PushError(`Unknown: push pages ${shown(action)}. Use push pages, push pages open or push pages lock.`);
  return editorCommand(site, action ? (action === 'open' ? 'show' : 'hide') : undefined, action ? ['pages'] : [], action ? options : { yes: true });
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
