// WP-CLI + PHP spawning. Never invoke wp.bat from Node: spawn() refuses .bat/.cmd
// without shell:true since Node 18.20.2, and shell:true routes every argument
// through cmd.exe — a quoting hazard for PHP payloads containing namespace
// separators (e.g. the AdminLoginLink FQCN used later). Spawning php.exe
// directly against wp-cli.phar with shell:false sidesteps all of that.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { LARAGON_ROOT, WP_CLI_CACHE_DIR } from './paths.mjs';

const FCGID_CONF = join(LARAGON_ROOT, 'etc', 'apache2', 'fcgid.conf');
const PHP_BASE = join(LARAGON_ROOT, 'bin', 'php');
const USR_BIN = join(LARAGON_ROOT, 'usr', 'bin');
const WP_CLI_PHAR = join(USR_BIN, 'wp-cli.phar');
const WP_CLI_BAT = join(USR_BIN, 'wp.bat');
// PINNED to a specific WP-CLI release, with the digest WP-CLI publishes
// alongside it (verified to match the real artifact before being embedded
// here). The old URL was the wp-cli/builds gh-pages branch — a MUTABLE
// artifact fetched once and then executed on every wp call forever, i.e.
// trust-on-first-use. Bump both lines together, never one alone.
const WP_CLI_VERSION = '2.12.0';
const WP_CLI_URL = `https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar`;
const WP_CLI_SHA512 = 'be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832';

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
  const dirs = (await readdir(PHP_BASE)).sort(compareVersionsDesc);
  for (const d of dirs) {
    const exe = join(PHP_BASE, d, 'php.exe');
    if (await exists(exe)) {
      cachedPhpExe = exe;
      return exe;
    }
  }
  throw new Error(`No php.exe found under ${PHP_BASE}`);
}

/** Numeric-aware descending sort for versioned dir names — a plain string sort puts "php-8.9" above "php-8.10". */
export function compareVersionsDesc(a, b) {
  const numsA = (a.match(/\d+/g) || []).map(Number);
  const numsB = (b.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(numsA.length, numsB.length); i += 1) {
    const diff = (numsB[i] ?? -1) - (numsA[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
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

/**
 * `expectedSha512`, when given, is verified BEFORE the bytes are written to
 * disk — so a tampered or truncated artifact never lands somewhere we would
 * later execute. Used for wp-cli.phar, which this tool installs once and
 * then runs on every `wp` call: fetch-and-execute without verification is
 * trust-on-first-use, and the digest closes it.
 */
async function downloadFile(url, dest, { expectedSha512 } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} -> HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (expectedSha512) {
    const actual = createHash('sha512').update(bytes).digest('hex');
    if (actual !== expectedSha512) {
      throw new Error(
        `Refusing to install ${url}: SHA-512 mismatch.\n` +
          `  expected ${expectedSha512}\n  actual   ${actual}\n` +
          '  The download was corrupted or tampered with — nothing was written.',
      );
    }
  }
  await writeFile(dest, bytes);
}

export async function wpCliPresent() {
  return exists(WP_CLI_PHAR);
}

/**
 * Download wp-cli.phar + write a wp.bat shim into <laragon>\usr\bin (empty,
 * on PATH when Laragon's "Add to Path" was applied, no elevation needed) —
 * for humans; our own calls never depend on the shim. The bat is rewritten
 * on EVERY call, not just first install: it bakes in an absolute php.exe
 * path, and Laragon's one-click PHP version switch can delete that directory
 * — a stale bat then breaks `npm run wp` in every scaffolded site while the
 * scaffolder itself (which re-resolves PHP per process) keeps working.
 */
export async function ensureWpCli() {
  await mkdir(USR_BIN, { recursive: true });
  if (!(await exists(WP_CLI_PHAR))) {
    await downloadFile(WP_CLI_URL, WP_CLI_PHAR, { expectedSha512: WP_CLI_SHA512 });
  }
  const php = await resolvePhpExe();
  const batContent = `@echo off\r\n"${php}" -d memory_limit=512M "%~dp0wp-cli.phar" %*\r\n`;
  const current = await readFile(WP_CLI_BAT, 'utf8').catch(() => '');
  if (current !== batContent) {
    await writeFile(WP_CLI_BAT, batContent, 'utf8');
  }
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
  const tmp = join(tmpdir(), `agentpress-eval-${randomBytes(6).toString('hex')}.php`);
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
