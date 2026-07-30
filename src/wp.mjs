// WP-CLI + PHP spawning. Never invoke wp.bat from Node: spawn() refuses .bat/.cmd
// without shell:true since Node 18.20.2, and shell:true routes every argument
// through cmd.exe — a quoting hazard for PHP payloads containing namespace
// separators (e.g. the AdminLoginLink FQCN used later). Spawning php.exe
// directly against wp-cli.phar with shell:false sidesteps all of that.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LARAGON_ROOT, WP_CLI_CACHE_DIR } from './paths.mjs';

const FCGID_CONF = join(LARAGON_ROOT, 'etc', 'apache2', 'fcgid.conf');
const PHP_BASE = join(LARAGON_ROOT, 'bin', 'php');
const USR_BIN = join(LARAGON_ROOT, 'usr', 'bin');
const WP_CLI_PHAR = join(USR_BIN, 'wp-cli.phar');
const WP_CLI_BAT = join(USR_BIN, 'wp.bat');
const WP_CLI_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';

export { LARAGON_ROOT, WP_CLI_CACHE_DIR };

let cachedPhpExe = null;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the exact php.exe Apache actually serves PHP with (read from
 * fcgid.conf's FcgidWrapper), not whatever "php" happens to resolve to on
 * PATH — those two can and do differ (verified: PATH = 8.4.14, mod_php.conf
 * (unused) = 8.3.16, Laragon Terminal PATH = 8.3.16, fcgid.conf = 8.4.14).
 */
export async function resolvePhpExe() {
  if (cachedPhpExe) return cachedPhpExe;
  try {
    const conf = await readFile(FCGID_CONF, 'utf8');
    const m = conf.match(/FcgidWrapper\s+"([^"]+)\/php-cgi\.exe"/i);
    if (m) {
      const exe = join(m[1].replace(/\//g, '\\'), 'php.exe');
      if (await exists(exe)) {
        cachedPhpExe = exe;
        return exe;
      }
    }
  } catch {
    // fall through to directory scan
  }
  const dirs = (await readdir(PHP_BASE)).sort().reverse();
  for (const d of dirs) {
    const exe = join(PHP_BASE, d, 'php.exe');
    if (await exists(exe)) {
      cachedPhpExe = exe;
      return exe;
    }
  }
  throw new Error(`No php.exe found under ${PHP_BASE}`);
}

export async function phpVersion() {
  const php = await resolvePhpExe();
  const { stdout } = await spawnCapture(php, ['-r', 'echo PHP_VERSION;']);
  return stdout.trim();
}

/** `opts.input`, if given, is written to stdin and the stream closed — e.g. `wp config create --extra-php` reads its PHP block from STDIN. Stdin is always closed (written or not) so a command that unexpectedly waits on it can't hang the caller. */
function spawnCapture(cmd, args, opts = {}) {
  const { input, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: false, ...spawnOpts });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: null, stdout, stderr: stderr + String(err) }));
    if (child.stdin) {
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} -> HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

export async function wpCliPresent() {
  return exists(WP_CLI_PHAR);
}

/** Download wp-cli.phar + write a wp.bat shim into C:\laragon\usr\bin (empty, on PATH, no elevation needed) — for humans; our own calls never depend on the shim. */
export async function ensureWpCli() {
  if (await exists(WP_CLI_PHAR)) return WP_CLI_PHAR;
  await mkdir(USR_BIN, { recursive: true });
  await downloadFile(WP_CLI_URL, WP_CLI_PHAR);
  const php = await resolvePhpExe();
  const batContent = `@echo off\r\n"${php}" -d memory_limit=512M "%~dp0wp-cli.phar" %*\r\n`;
  await writeFile(WP_CLI_BAT, batContent, 'utf8');
  return WP_CLI_PHAR;
}

/**
 * Run a WP-CLI command. `path` is the WordPress root (--path); omit for
 * commands that don't need one (e.g. `--info`). Never resolves via shell.
 */
export async function runWp(args, { path, cwd, env, input } = {}) {
  const php = await resolvePhpExe();
  const phar = await ensureWpCli();
  await mkdir(WP_CLI_CACHE_DIR, { recursive: true }).catch(() => {});
  const fullArgs = ['-d', 'memory_limit=512M', phar];
  if (path) fullArgs.push(`--path=${path}`);
  fullArgs.push(...args);
  return spawnCapture(php, fullArgs, {
    cwd,
    env: { ...process.env, WP_CLI_CACHE_DIR, ...env },
    input,
  });
}

/**
 * `wp eval-file`, not `wp eval "<code>"` — a real file on disk is debuggable
 * by hand and sidesteps argv-length/quoting concerns for multi-line PHP
 * (e.g. namespaced FQCNs) even though shell:false already avoids cmd.exe.
 */
export async function runWpEvalFile(phpSource, opts = {}) {
  const tmp = join(tmpdir(), `katalyst-eval-${randomBytes(6).toString('hex')}.php`);
  // eval-file loads the file as a normal PHP script (unlike `wp eval`,
  // which the original used — a bare code string with no tag needed).
  // Content outside `<?php ?>` is literal output, so a source string
  // without the tag gets echoed verbatim instead of executed.
  const content = /^\s*<\?php/.test(phpSource) ? phpSource : `<?php\n${phpSource}`;
  await writeFile(tmp, content, 'utf8');
  try {
    return await runWp(['eval-file', tmp], opts);
  } finally {
    await rm(tmp, { force: true });
  }
}

export { spawnCapture };
