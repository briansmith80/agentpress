// MCP server wiring for each detected agent, plus the WordPress application
// password that authenticates the stdio proxy against the site. Playwright
// runs over stdio here (no container, no --allowed-hosts flag needed — that
// existed only to let an HTTP server accept non-localhost clients).
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runWp } from './wp.mjs';
import { psRun } from './win.mjs';
import { LARAGON_ROOT } from './paths.mjs';

const APP_PASSWORD_NAME = 'katalyst-laragon';
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
export async function configureClaude(creds) {
  const envArgs = Object.entries(wordpressEnv(creds)).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  await psRun('claude', ['mcp', 'remove', 'wordpress', '--scope', 'user']);
  const wp = await psRun('claude', ['mcp', 'add', 'wordpress', '--scope', 'user', ...envArgs, '--', ...WP_MCP_PROXY]);
  if (wp.code !== 0) throw new Error(`claude mcp add wordpress failed (exit ${wp.code}): ${(wp.stderr || wp.stdout).trim()}`);
  await psRun('claude', ['mcp', 'remove', 'playwright', '--scope', 'user']);
  const pw = await psRun('claude', ['mcp', 'add', 'playwright', '--scope', 'user', '--', ...PLAYWRIGHT_MCP]);
  if (pw.code !== 0) throw new Error(`claude mcp add playwright failed (exit ${pw.code}): ${(pw.stderr || pw.stdout).trim()}`);
}

export async function configureCodex(creds) {
  const envArgs = Object.entries(wordpressEnv(creds)).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  await psRun('codex', ['mcp', 'remove', 'wordpress']);
  const wp = await psRun('codex', ['mcp', 'add', 'wordpress', ...envArgs, '--', ...WP_MCP_PROXY]);
  if (wp.code !== 0) throw new Error(`codex mcp add wordpress failed (exit ${wp.code}): ${(wp.stderr || wp.stdout).trim()}`);
  await psRun('codex', ['mcp', 'remove', 'playwright']);
  const pw = await psRun('codex', ['mcp', 'add', 'playwright', '--', ...PLAYWRIGHT_MCP]);
  if (pw.code !== 0) throw new Error(`codex mcp add playwright failed (exit ${pw.code}): ${(pw.stderr || pw.stdout).trim()}`);
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
