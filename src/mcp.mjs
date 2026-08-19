// MCP server wiring for each detected agent, plus the WordPress application
// password that authenticates the stdio proxy against the site. Playwright
// runs over stdio here (no container, no --allowed-hosts flag needed — that
// existed only to let an HTTP server accept non-localhost clients).
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { firstPhpDiagnostic, runWp, stripPhpDiagnostics } from './wp.mjs';
import { psRun } from './win.mjs';
import { LARAGON_ROOT } from './paths.mjs';

const APP_PASSWORD_NAME = 'agentpress';
// WordPress mints these as wp_generate_password( 24, false ) — alphanumerics
// only, no separators, one line. The range is loose on purpose: the point is to
// reject prose and multi-line buffers, not to pin core's current PW_LENGTH.
const APP_PASSWORD_SHAPE = /^[A-Za-z0-9]{16,64}$/;
// Both spellings are ours: pre-rename sites carry the old name, and destroy
// used to try to remove it separately. One list means revocation covers both.
export const APP_PASSWORD_NAMES = [APP_PASSWORD_NAME, 'katalyst-laragon'];
const LARAGON_CRT = join(LARAGON_ROOT, 'etc', 'ssl', 'laragon.crt');
// Pinned versions, not @latest — these resolve at every agent session
// start, so an upstream breaking release would instantly break MCP for
// every EXISTING site on every machine with zero local change. Bump
// deliberately, test, then re-scaffold or re-wire.
const WP_MCP_PROXY = ['npx', '-y', '@automattic/mcp-wordpress-remote@0.4.0'];
/**
 * `--output-dir` is not cosmetic. Without it @playwright/mcp writes every
 * screenshot and page snapshot into `.playwright-mcp/` under whatever directory
 * the agent was started in, i.e. straight into the user's site folder — and it
 * writes a snapshot `.yml` alongside the PNG, so an agent told to "delete the
 * screenshot" leaves half of it behind. Reported from the field after a
 * `/verify` run.
 *
 * When the agent starts at the project root that is only litter: the docroot is
 * `public/`, so the root is not served (the same property `curl …/.env` → 404
 * proves). When it starts INSIDE `public/` the files are publicly served.
 * Sending the output outside the site covers both, and retires the manual
 * cleanup step `/verify` used to carry.
 *
 * Absolute and resolved here rather than left relative: this string is baked
 * into a machine-global agent config, so it must not depend on the agent's cwd
 * — which is the entire bug. Spaces are safe (psRun single-quotes every token,
 * the JSON writers pass argv arrays); a temp path cannot contain the double
 * quote psRun refuses.
 *
 * HALF A FIX ON ITS OWN, verified by driving the server over stdio rather than
 * trusting `--help`: the flag governs only the DEFAULT filename. An explicit
 * relative `filename` argument is resolved against the agent's cwd and escapes
 * the output dir completely. `/verify` therefore also tells agents not to pass
 * one; changing this flag without keeping that instruction in step 4 re-opens
 * the bug for any agent that names its screenshot.
 */
const PLAYWRIGHT_OUTPUT_DIR = join(tmpdir(), 'agentpress-playwright');
const PLAYWRIGHT_MCP = ['npx', '-y', '@playwright/mcp@0.0.78', '--output-dir', PLAYWRIGHT_OUTPUT_DIR];

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
    entries = JSON.parse(stripPhpDiagnostics(list.stdout).trim() || '[]');
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
  return parseMintedAppPassword(result.stdout);
}

/**
 * The password out of `--porcelain`'s stdout, or a throw naming why not.
 *
 * Separate from mintAppPassword, and exported, so the check that guards a
 * credential is directly testable without Laragon: it is the whole of the fix
 * for issue #1 and must not be the untested part of it.
 *
 * 1.10.0 wrote this buffer into .mcp.json's WP_API_PASSWORD verbatim. On PHP 8.5
 * the real 24 characters were on the END — correct, and authenticating fine in
 * isolation — behind a PHP deprecation notice that turned every MCP request into
 * a 401 with zero tools and no clue why. A credential read out of a stream that
 * can also carry prose has to be checked where it is created, not discovered as
 * an opaque 401 an hour later.
 */
export function parseMintedAppPassword(stdout) {
  const password = stripPhpDiagnostics(stdout).trim();
  if (APP_PASSWORD_SHAPE.test(password)) return password;
  const cause = firstPhpDiagnostic(stdout);
  // Never echo the buffer itself: on the failure this exists for it still holds
  // a live credential right behind the prose. Name the CAUSE instead.
  throw new Error(
    'WordPress returned an application password of an unexpected shape, so nothing was written.\n' +
      (cause
        ? `  Cause: PHP wrote a diagnostic to WP-CLI's stdout, which is where the password is read from:\n    ${cause}\n` +
          "  Fix: set display_errors=stderr in the CLI PHP's php.ini, then run `rewire` again.\n"
        : `  Got ${password.length} character(s); expected 16-64 alphanumerics on one line.\n`) +
      '  (The value itself is deliberately not printed — the buffer may hold a live credential.)',
  );
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
 * `.mcp.json` carries the application password, so it must never reach a
 * repo. The template `.gitignore` ships the entry for new sites; this
 * re-ensures it on every wiring, because a site created before 1.10.0 keeps
 * its original `.gitignore` until `update` runs — the same belt-and-braces
 * as the snapshots folder's own marker.
 */
async function ensureMcpJsonIgnored(siteDir) {
  const path = join(siteDir, '.gitignore');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {
    // no .gitignore at all — create one holding just this rule
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === '.mcp.json')) return;
  const addition = '# Per-site MCP wiring for Claude Code — carries the application password.\n.mcp.json\n';
  await writeFile(path, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${addition}`, 'utf8');
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

/**
 * Claude Code is wired PER SITE via a project-scoped `.mcp.json`, not the
 * machine-global user scope the other CLIs still use. Spiked live 2026-08-12:
 * project config connects once the user approves it (one prompt on first
 * launch in the folder, both servers pre-selected), it beats a user-scope
 * entry of the same name inside the site, and a folder without the file
 * resolves nothing. That deletes the "newest scaffold silently steals every
 * agent" class for Claude Code — most of what `rewire` existed to repair.
 *
 * Legacy user-scope entries written by pre-1.10.0 versions are deliberately
 * left alone: the project file wins locally, and the global entry keeps
 * serving sites that have not migrated yet (`rewire` in a site migrates it).
 *
 * updateJsonConfig gives this the same guarantees as the Cursor/OpenCode
 * writers: a user's own servers in an existing `.mcp.json` survive, an
 * unparseable file is refused untouched, and the write is temp+rename. No
 * CLI fallback needed anymore — the old one existed for an unparseable
 * ~/.claude.json full of unrelated state; a site's own `.mcp.json` has no
 * such file to inherit, and if a user hand-broke theirs, refusing loudly
 * beats putting the password on an argv.
 */
export async function configureClaude(creds) {
  if (!creds.siteDir) throw new Error('configureClaude needs creds.siteDir — the site folder that owns .mcp.json');
  await updateJsonConfig(join(creds.siteDir, '.mcp.json'), (config) => {
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.wordpress = { type: 'stdio', command: WP_MCP_PROXY[0], args: WP_MCP_PROXY.slice(1), env: wordpressEnv(creds) };
    config.mcpServers.playwright = { type: 'stdio', command: PLAYWRIGHT_MCP[0], args: PLAYWRIGHT_MCP.slice(1), env: {} };
  });
  await ensureMcpJsonIgnored(creds.siteDir);
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
  /**
   * Settles on EVERY terminal condition, not just the happy one, and behind a
   * wall-clock deadline.
   *
   * The first version listened only for res 'end', req 'timeout' and req
   * 'error'. When a peer closes the connection AFTER headers arrive — a PHP
   * fatal mid-response, an FcgidIOTimeout kill, or the Laragon Stop All this
   * project's own docs keep asking for — Node emits res 'aborted'/'close' and
   * req 'close' instead, and req 'error' never fires. The `timeout` option is a
   * socket-inactivity timer, so once that socket is destroyed it cannot fire
   * either. The promise never settled, and because nothing else held the event
   * loop open the process could reach exit(0) without ever running the rest of
   * the scaffold: the run vanished after "checking the MCP endpoint answers…"
   * having already created the site but not its templates, sandbox.config.json,
   * registry entry or admin link. Reproduced three ways before fixing.
   */
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
      let settled = false;
      let deadline;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(value);
      };
      const req = http.request(
        { host: '127.0.0.1', port: target.port || 80, path: target.pathname, method: 'POST', headers, timeout: timeoutMs },
        (res) => {
          let text = '';
          res.on('data', (d) => (text += d));
          res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: text }));
          // A response cut short after headers: 'aborted'/'error'/'close' are
          // the only signals, and an unhandled res 'error' is swallowed.
          res.on('aborted', () => done({ status: 0, body: 'the connection closed before the response finished' }));
          res.on('error', (err) => done({ status: 0, body: err.code || String(err.message) }));
          res.on('close', () => done({ status: 0, body: 'the connection closed before the response finished' }));
        },
      );
      // Wall clock, not socket inactivity — the backstop that makes it
      // impossible for any transport quirk to stall a scaffold.
      deadline = setTimeout(() => {
        req.destroy();
        done({ status: 0, body: 'timed out' });
      }, timeoutMs);
      if (typeof deadline.unref === 'function') deadline.unref();
      req.on('timeout', () => {
        req.destroy();
        done({ status: 0, body: 'timed out' });
      });
      req.on('error', (err) => done({ status: 0, body: err.code || String(err.message) }));
      req.on('close', () => done({ status: 0, body: 'the connection closed before a response arrived' }));
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
