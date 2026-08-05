// MCP server wiring for each detected agent, plus the WordPress application
// password that authenticates the stdio proxy against the site. Playwright
// runs over stdio here (no container, no --allowed-hosts flag needed — that
// existed only to let an HTTP server accept non-localhost clients).
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runWp } from './wp.mjs';
import { psRun } from './win.mjs';
import { LARAGON_ROOT } from './paths.mjs';
import { yellow, WARN } from './ansi.mjs';

const APP_PASSWORD_NAME = 'agentpress';
// Both spellings are ours: pre-rename sites carry the old name, and destroy
// used to try to remove it separately. One list means revocation covers both.
export const APP_PASSWORD_NAMES = [APP_PASSWORD_NAME, 'katalyst-laragon'];
const LARAGON_CRT = join(LARAGON_ROOT, 'etc', 'ssl', 'laragon.crt');
// Pinned versions, not @latest — these resolve at every agent session
// start, so an upstream breaking release would instantly break MCP for
// every EXISTING site on every machine with zero local change. Bump
// deliberately, test, then re-scaffold or re-wire.
const WP_MCP_PROXY = ['npx', '-y', '@automattic/mcp-wordpress-remote@0.4.0'];
const PLAYWRIGHT_MCP = ['npx', '-y', '@playwright/mcp@0.0.78'];

/**
 * Revokes every application password we created, by NAME — never `--all`,
 * which on a long-lived machine would delete passwords the user created by
 * hand for other purposes.
 *
 * `wp user application-password delete <user> [<uuid>...]` takes UUIDs, NOT
 * names. Passing the name (which this did until v1.5.0) matched nothing, so
 * the delete was a silent no-op: it printed "Deleted 0 of 1" and exited 1,
 * and nobody checked. Two consequences, both live-verified: every re-mint
 * ADDED another valid admin-equivalent credential (WP core appends without a
 * duplicate-name check), and `destroy` never revoked anything despite telling
 * the user it does. So: resolve the UUIDs first, then delete those.
 *
 * Returns how many were revoked, or null when the lookup itself failed — the
 * caller can then say "could not confirm" rather than implying success.
 */
export async function revokeAppPasswords({ path, adminUser }) {
  const list = await runWp(['user', 'application-password', 'list', adminUser, '--fields=uuid,name', '--format=json'], { path });
  if (list.code !== 0) return null;
  let entries;
  try {
    entries = JSON.parse(list.stdout.trim() || '[]');
  } catch {
    return null;
  }
  const uuids = entries.filter((e) => APP_PASSWORD_NAMES.includes(String(e.name))).map((e) => e.uuid);
  if (!uuids.length) return 0; // nothing of ours on this site — success, not failure
  const del = await runWp(['user', 'application-password', 'delete', adminUser, ...uuids], { path });
  if (del.code !== 0) return null;
  return uuids.length;
}

/**
 * The plaintext only exists at creation time, so this always revokes then
 * recreates rather than trying to reuse an existing password. A failed revoke
 * is reported but not fatal: a site that ends up with one stale extra
 * credential is better than a scaffold that dies here (see engine.js, which
 * degrades the whole MCP step rather than aborting).
 */
export async function mintAppPassword({ path, adminUser, onStep }) {
  const revoked = await revokeAppPasswords({ path, adminUser });
  if (revoked === null) {
    onStep?.('(could not revoke this site\'s previous application password — a stale one may remain; check wp-admin ▸ Users ▸ Profile)');
  }
  const result = await runWp(['user', 'application-password', 'create', adminUser, APP_PASSWORD_NAME, '--porcelain'], { path });
  if (result.code !== 0) throw new Error(`Failed to mint application password: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

/** Never let a captured stdout/stderr echo a credential into the console (or an AI agent's uploaded session transcript). */
function redactSecrets(text, creds) {
  let out = String(text || '');
  for (const secret of [creds?.password].filter((s) => s && String(s).length > 6)) {
    out = out.split(secret).join('***');
  }
  return out;
}

function wordpressEnv({ wpApiUrl, username, password }) {
  const env = {
    WP_API_URL: wpApiUrl,
    WP_API_USERNAME: username,
    WP_API_PASSWORD: password,
    OAUTH_ENABLED: 'false',
  };
  // Only when the cert actually exists — Laragon generates it lazily on
  // first SSL enable, and pointing Node at a missing file adds a warning
  // line to every MCP proxy launch inside the user's agent. When present:
  // harmless on http; makes an eventual https switch (the site already gets
  // a valid cert for free via Laragon's *.test SAN) work with no code
  // change, since this is Laragon's own self-signed CA.
  if (existsSync(LARAGON_CRT)) env.NODE_EXTRA_CA_CERTS = LARAGON_CRT;
  return env;
}

/**
 * Read-modify-write for another tool's config file, with the discipline the
 * Claude path already had and these two lacked until v1.5.0.
 *
 * The old readJson mapped EVERY failure to `{}`, which conflated "file does
 * not exist yet" (fine, create it) with "file exists but I cannot parse it"
 * (a user's config with a stray comment, or the client caught mid-write). The
 * caller then wrote a file containing only our two servers, silently deleting
 * every other MCP server and setting the user had, with no backup taken.
 *
 * So: absent is fine, unparseable THROWS (engine.js reports that agent as
 * skipped and leaves the file alone), and the write is temp+rename so an
 * interrupted scaffold can never leave a truncated config behind.
 */
async function updateJsonConfig(path, mutate) {
  let config = {};
  try {
    config = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`refusing to rewrite ${path}: it exists but could not be read as JSON (${err.message}). Fix or move it, then re-run.`);
    }
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`refusing to rewrite ${path}: expected a JSON object at the top level.`);
  }
  mutate(config);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.agentpress-tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * `claude` and `codex` resolve via PATH to npm-global `.cmd`/`.ps1` shims on
 * Windows, not `.exe` — `spawn(shell:false)` can't launch those directly
 * (confirmed live: bare `spawn('claude', …)` fails with `spawn claude
 * ENOENT`), the same class of issue `wp.mjs` already routes around for
 * `wp.bat`. `psRun` (shared with `destroy.mjs`'s MCP cleanup, same problem)
 * goes through real `powershell.exe` instead of spawning the shim directly.
 */
/**
 * Writes ~/.claude.json DIRECTLY rather than shelling out to `claude mcp add`,
 * because that CLI takes the credential on argv (`--env WP_API_PASSWORD=…`) —
 * which puts an admin-equivalent REST password on two process command lines,
 * where EDR/Sysmon/4688 command-line auditing and PowerShell transcription
 * persist it off-machine, outliving the site. Cursor and OpenCode were always
 * configured this way; this brings Claude in line.
 *
 * Not riskier than the CLI: `claude mcp add` is itself a separate process
 * doing read-modify-write on the same file. But that file holds a lot of
 * unrelated Claude Code state, so the write is atomic (temp + rename in the
 * same directory), keeps a backup only for the duration of the write,
 * preserves every unknown key, and reads back to confirm. An ABSENT file is
 * created here; only an unparseable file or a failed read-back falls back to
 * the CLI, and that fallback now says so out loud.
 */
async function writeClaudeConfig(creds) {
  const path = join(homedir(), '.claude.json');
  let raw = null;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    // ABSENT is not a reason to fall back. Claude Code installed but never
    // launched has no ~/.claude.json, which is the ordinary state for a new
    // user — and routing that through the CLI put the password on an argv for
    // exactly the people least likely to notice. Creating the file ourselves is
    // strictly safer and keeps the credential out of every process list.
    if (err.code !== 'ENOENT') return false;
  }
  let config = {};
  if (raw !== null) {
    try {
      config = JSON.parse(raw);
    } catch {
      return false; // never overwrite a file we cannot parse
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  }

  // Kept only for the duration of the write. It used to be left behind
  // forever, rewritten on every scaffold — a full plaintext copy of the user's
  // entire Claude config (every MCP server's env, so third-party API keys too)
  // plus the PREVIOUS site's application password, which until v1.5.0 was
  // never actually revoked. The temp+rename below is what makes the write
  // safe; the backup only covers the moment before it.
  const bak = `${path}.agentpress-bak`;
  await writeFile(bak, raw, 'utf8').catch(() => {});
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.wordpress = { type: 'stdio', command: WP_MCP_PROXY[0], args: WP_MCP_PROXY.slice(1), env: wordpressEnv(creds) };
  config.mcpServers.playwright = { type: 'stdio', command: PLAYWRIGHT_MCP[0], args: PLAYWRIGHT_MCP.slice(1), env: {} };

  const tmp = `${path}.agentpress-tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(tmp, path); // atomic on NTFS — no truncated-file window

  try {
    const back = JSON.parse(await readFile(path, 'utf8'));
    const ok = Boolean(back.mcpServers?.wordpress?.env?.WP_API_URL);
    // Only once the new config is confirmed on disk — otherwise the backup is
    // the only copy of the user's state and must survive.
    if (ok) await rm(bak, { force: true }).catch(() => {});
    return ok;
  } catch {
    return false;
  }
}

/**
 * Which site the machine-global `wordpress` MCP entry currently points at, per
 * agent — the question every part of this tool was previously unable to answer.
 * The wiring is machine-global by design (newest scaffold wins), so "is this
 * site the live one?" needs reading it back, not assuming.
 *
 * Read-only and best-effort: an agent with no config, or an unreadable one,
 * reports `null` rather than throwing. codex is absent on purpose — its config
 * is TOML we do not parse, and `codex mcp get` masks env values, so its target
 * genuinely cannot be determined without guessing.
 */
export async function readWiredHostnames() {
  const out = {};
  const fromUrl = (url) => {
    try {
      return new URL(String(url)).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  const claude = await readFile(join(homedir(), '.claude.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (claude) out.claude = fromUrl(claude.mcpServers?.wordpress?.env?.WP_API_URL);
  const cursor = await readFile(join(homedir(), '.cursor', 'mcp.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (cursor) out.cursor = fromUrl(cursor.mcpServers?.wordpress?.env?.WP_API_URL);
  const opencode = await readFile(join(homedir(), '.config', 'opencode', 'opencode.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (opencode) out.opencode = fromUrl(opencode.mcp?.wordpress?.environment?.WP_API_URL);
  return out;
}

export async function configureClaude(creds) {
  if (await writeClaudeConfig(creds)) return;
  // Fallback: the CLI. Keeps working on a machine whose config we could not
  // safely edit, at the cost of the argv exposure documented above — which is
  // now DISCLOSED rather than silent, since SECURITY.md promises the direct
  // write and a user is entitled to know when they did not get it.
  console.log(
    `${yellow(WARN)} ~/.claude.json could not be read as JSON, so this site's MCP entry is being written\n` +
      "  via `claude mcp add` instead. That puts the application password on a command line,\n" +
      '  where command-line auditing can persist it. Fix or move that file and run `rewire` to\n' +
      '  get the direct write.',
  );
  const envArgs = Object.entries(wordpressEnv(creds)).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  await psRun('claude', ['mcp', 'remove', 'wordpress', '--scope', 'user']);
  const wp = await psRun('claude', ['mcp', 'add', 'wordpress', '--scope', 'user', ...envArgs, '--', ...WP_MCP_PROXY]);
  if (wp.code !== 0) throw new Error(`claude mcp add wordpress failed (exit ${wp.code}): ${redactSecrets((wp.stderr || wp.stdout).trim(), creds)}`);
  await psRun('claude', ['mcp', 'remove', 'playwright', '--scope', 'user']);
  const pw = await psRun('claude', ['mcp', 'add', 'playwright', '--scope', 'user', '--', ...PLAYWRIGHT_MCP]);
  if (pw.code !== 0) throw new Error(`claude mcp add playwright failed (exit ${pw.code}): ${redactSecrets((pw.stderr || pw.stdout).trim(), creds)}`);
}

export async function configureCodex(creds) {
  const envArgs = Object.entries(wordpressEnv(creds)).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  await psRun('codex', ['mcp', 'remove', 'wordpress']);
  const wp = await psRun('codex', ['mcp', 'add', 'wordpress', ...envArgs, '--', ...WP_MCP_PROXY]);
  if (wp.code !== 0) throw new Error(`codex mcp add wordpress failed (exit ${wp.code}): ${redactSecrets((wp.stderr || wp.stdout).trim(), creds)}`);
  await psRun('codex', ['mcp', 'remove', 'playwright']);
  const pw = await psRun('codex', ['mcp', 'add', 'playwright', '--', ...PLAYWRIGHT_MCP]);
  if (pw.code !== 0) throw new Error(`codex mcp add playwright failed (exit ${pw.code}): ${redactSecrets((pw.stderr || pw.stdout).trim(), creds)}`);
}

/**
 * Written directly as JSON, not via a CLI — Cursor's own MCP client has
 * historically failed to resolve a bare `command: "npx"` on Windows, so
 * this wraps it through `cmd /c`, which is what THEIR client needs to work
 * correctly (nothing to do with how WE spawn anything — we never execute
 * this ourselves, Cursor does, later, at its own runtime).
 */
export async function configureCursor(creds) {
  await updateJsonConfig(join(homedir(), '.cursor', 'mcp.json'), (config) => {
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.wordpress = { command: 'cmd', args: ['/c', ...WP_MCP_PROXY], env: wordpressEnv(creds) };
    config.mcpServers.playwright = { command: 'cmd', args: ['/c', ...PLAYWRIGHT_MCP] };
  });
}

export async function configureOpenCode(creds) {
  await updateJsonConfig(join(homedir(), '.config', 'opencode', 'opencode.json'), (config) => {
    config['$schema'] = config['$schema'] || 'https://opencode.ai/config.json';
    config.mcp = config.mcp || {};
    config.mcp.wordpress = { type: 'local', command: ['cmd', '/c', ...WP_MCP_PROXY], environment: wordpressEnv(creds), enabled: true };
    config.mcp.playwright = { type: 'local', command: ['cmd', '/c', ...PLAYWRIGHT_MCP], enabled: true };
  });
}

export const MCP_CONFIGURERS = { claude: configureClaude, cursor: configureCursor, codex: configureCodex, opencode: configureOpenCode };

/**
 * Proves the wiring we just wrote actually works, instead of asserting it.
 * "MCP wired for: claude" used to be printed without anything ever having
 * spoken to the endpoint — so a dead route, a stripped Authorization header or
 * a bad credential surfaced later, inside the user's agent, as an opaque
 * connection failure with no pointer back to this tool.
 *
 * Speaks MCP directly over the loopback with a Host header (no DNS, works
 * before the hosts entry lands): `initialize` to get a session, then
 * `tools/list`. Deliberately does NOT go through the npx proxy — that would
 * test npm resolution rather than the site.
 *
 * Returns { ok, tools, detail }. Never throws: this is a check, and a site
 * that cannot be verified must not fail a scaffold.
 */
export async function verifyMcpEndpoint({ wpApiUrl, username, password, timeoutMs = 15_000 }) {
  const http = await import('node:http');
  let target;
  try {
    target = new URL(wpApiUrl);
  } catch {
    return { ok: false, detail: `not a valid URL: ${wpApiUrl}` };
  }
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const call = (payload, sessionId) =>
    new Promise((resolve) => {
      const body = JSON.stringify(payload);
      const headers = {
        Host: target.hostname,
        'Content-Type': 'application/json',
        // The streamable-HTTP transport answers either way; accept both.
        Accept: 'application/json, text/event-stream',
        Authorization: auth,
        'Content-Length': Buffer.byteLength(body),
      };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      const req = http.request(
        { host: '127.0.0.1', port: target.port || 80, path: target.pathname, method: 'POST', headers, timeout: timeoutMs },
        (res) => {
          let text = '';
          res.on('data', (d) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, body: 'timed out' });
      });
      req.on('error', (err) => resolve({ status: 0, body: err.code || String(err.message) }));
      req.end(body);
    });

  const init = await call({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agentpress-verify', version: '1' } },
  });
  if (init.status === 401 || init.status === 403) {
    return { ok: false, detail: `the site rejected the credential (HTTP ${init.status})` };
  }
  if (init.status !== 200) {
    return { ok: false, detail: `initialize returned HTTP ${init.status || 'no response'}${init.body ? ` (${String(init.body).slice(0, 80)})` : ''}` };
  }
  const sessionId = init.headers?.['mcp-session-id'];
  if (!sessionId) return { ok: false, detail: 'the endpoint issued no MCP session id' };

  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
  if (list.status !== 200) return { ok: false, detail: `tools/list returned HTTP ${list.status || 'no response'}` };
  // The response may arrive as JSON or as an SSE frame; count tool names either way.
  const names = [...String(list.body).matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]);
  if (!names.length) return { ok: false, detail: 'the endpoint exposed no tools' };
  return { ok: true, tools: names.length };
}
