// MCP server wiring for each detected agent, plus the WordPress application
// password that authenticates the stdio proxy against the site. Playwright
// runs over stdio here (no container, no --allowed-hosts flag needed — that
// existed only to let an HTTP server accept non-localhost clients).
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runWp } from './wp.mjs';
import { psRun } from './win.mjs';
import { LARAGON_ROOT } from './paths.mjs';

const APP_PASSWORD_NAME = 'agentpress';
const LARAGON_CRT = join(LARAGON_ROOT, 'etc', 'ssl', 'laragon.crt');
// Pinned versions, not @latest — these resolve at every agent session
// start, so an upstream breaking release would instantly break MCP for
// every EXISTING site on every machine with zero local change. Bump
// deliberately, test, then re-scaffold or re-wire.
const WP_MCP_PROXY = ['npx', '-y', '@automattic/mcp-wordpress-remote@0.4.0'];
const PLAYWRIGHT_MCP = ['npx', '-y', '@playwright/mcp@0.0.78'];

/**
 * Rotates a NAMED application password — never `--all`, which on a
 * long-lived machine would delete passwords the user created by hand for
 * other purposes. The plaintext only exists at creation time, hence
 * delete-then-recreate rather than trying to reuse an existing one.
 */
export async function mintAppPassword({ path, adminUser }) {
  await runWp(['user', 'application-password', 'delete', adminUser, APP_PASSWORD_NAME], { path });
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

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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
 * same directory), takes a one-time backup, preserves every unknown key, and
 * reads back to confirm. Anything unexpected (missing/unparseable file, failed
 * read-back) falls back to the CLI path rather than risking the file.
 */
async function writeClaudeConfig(creds) {
  const path = join(homedir(), '.claude.json');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return false; // no config yet — let the CLI create it
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return false; // never overwrite a file we cannot parse
  }
  if (!config || typeof config !== 'object') return false;

  await writeFile(`${path}.agentpress-bak`, raw, 'utf8').catch(() => {});
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.wordpress = { type: 'stdio', command: WP_MCP_PROXY[0], args: WP_MCP_PROXY.slice(1), env: wordpressEnv(creds) };
  config.mcpServers.playwright = { type: 'stdio', command: PLAYWRIGHT_MCP[0], args: PLAYWRIGHT_MCP.slice(1), env: {} };

  const tmp = `${path}.agentpress-tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(tmp, path); // atomic on NTFS — no truncated-file window

  try {
    const back = JSON.parse(await readFile(path, 'utf8'));
    return Boolean(back.mcpServers?.wordpress?.env?.WP_API_URL);
  } catch {
    return false;
  }
}

export async function configureClaude(creds) {
  if (await writeClaudeConfig(creds)) return;
  // Fallback: the CLI. Keeps working on a machine whose config we could not
  // safely edit, at the cost of the argv exposure documented above.
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
  const path = join(homedir(), '.cursor', 'mcp.json');
  const config = await readJson(path, {});
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.wordpress = { command: 'cmd', args: ['/c', ...WP_MCP_PROXY], env: wordpressEnv(creds) };
  config.mcpServers.playwright = { command: 'cmd', args: ['/c', ...PLAYWRIGHT_MCP] };
  await writeJson(path, config);
}

export async function configureOpenCode(creds) {
  const path = join(homedir(), '.config', 'opencode', 'opencode.json');
  const config = await readJson(path, {});
  config['$schema'] = config['$schema'] || 'https://opencode.ai/config.json';
  config.mcp = config.mcp || {};
  config.mcp.wordpress = { type: 'local', command: ['cmd', '/c', ...WP_MCP_PROXY], environment: wordpressEnv(creds), enabled: true };
  config.mcp.playwright = { type: 'local', command: ['cmd', '/c', ...PLAYWRIGHT_MCP], enabled: true };
  await writeJson(path, config);
}

export const MCP_CONFIGURERS = { claude: configureClaude, cursor: configureCursor, codex: configureCodex, opencode: configureOpenCode };
