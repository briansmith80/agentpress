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
const WP_CLI_BAT = join(USR_BIN, 'wp.bat');
// PINNED to a specific WP-CLI release, with the digest WP-CLI publishes
// alongside it (verified to match the real artifact before being embedded
// here). The old URL was the wp-cli/builds gh-pages branch — a MUTABLE
// artifact fetched once and then executed on every wp call forever, i.e.
// trust-on-first-use. Bump both lines together, never one alone.
const WP_CLI_VERSION = '2.12.0';
const WP_CLI_URL = `https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar`;
// Version-scoped + tool-owned: never clobber a wp-cli the user installed as wp-cli.phar.
// Exported so `doctor` can report the path it will actually run instead of
// re-deriving one. It printed a bare `wp-cli.phar`, which has been the wrong
// filename since the version-scoped name landed in v1.2.0: a user following that
// row to delete the file found either nothing or their own unrelated phar.
export const WP_CLI_PHAR = join(USR_BIN, `wp-cli-${WP_CLI_VERSION}.phar`);
const WP_CLI_SHA512 = 'be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832';

export { LARAGON_ROOT, WP_CLI_CACHE_DIR };

// PHP's CLI SAPI sends display_errors output to STDOUT, not stderr — so every
// diagnostic PHP emits lands in the exact buffer we read VALUES out of, and
// `2>/dev/null` cannot help. Live-verified here with the pinned phar on PHP
// 8.5.1: `wp --version` prints a blank line, then
//   Deprecated: Case statements followed by a semicolon (;) are deprecated…
//   WP-CLI 2.12.0
// because WP-CLI 2.12.0 bundles a react/promise that writes `case X;` and PHP
// 8.5 deprecated that spelling. 2.12.0 is the latest release, so there is no
// version to upgrade to, and the phar is SHA-pinned so a hand-swap is reverted.
//
// Reported as issue #1 against 1.10.0, with two symptoms and one cause: the
// whole buffer became .mcp.json's WP_API_PASSWORD (so every MCP request 401'd
// and the server came up with zero tools), and the same pollution made the
// WP_ENVIRONMENT_TYPE probe compare "Deprecated: …\nlocal" against "local" and
// report a correct wp-config.php as missing the define — actively misdirecting
// diagnosis, since "app passwords need a local environment over http" is a
// real failure mode.
//
// `stderr` is a CLI-SAPI-only value for display_errors and it is the whole
// point: diagnostics stay visible to a human running `wp` by hand, they just
// stop contaminating machine-read output.
const PHP_DISPLAY_ERRORS = 'stderr';

// PHP's own diagnostic line shapes, as display_errors renders them with
// html_errors off (the CLI default). The `PHP ` prefix appears when the same
// text arrives via log_errors instead.
const PHP_DIAGNOSTIC_LINE =
  /^(PHP )?(Deprecated|Notice|Warning|Strict Standards|Fatal error|Parse error|Recoverable fatal error|Catchable fatal error|Unhandled exception):\s/;
// Continuation lines of a multi-line diagnostic (an uncaught throwable).
const PHP_DIAGNOSTIC_CONT = /^(Stack trace:\s*$|#\d+\s|\s+thrown in .+ on line \d+\s*$)/;

/**
 * Drop PHP's diagnostics from a captured stdout buffer, keeping everything
 * else line-for-line.
 *
 * Second line of defence behind PHP_DISPLAY_ERRORS, deliberately: that flag
 * fixes the source for calls we spawn, but display_errors is not the only way
 * text reaches stdout ahead of a value (a plugin echoing inside a hook, a
 * stray var_dump in wp-config.php, an mu-plugin's debug line), and reading a
 * value — above all a credential — out of a stream that can also carry prose
 * is unsafe regardless of PHP version. Never widen this to "take the last
 * line": `wp eval` output is legitimately multi-line and JSON formatters are
 * one long line, so a positional rule would corrupt exactly the reads this
 * protects.
 */
export function stripPhpDiagnostics(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const kept = [];
  let inDiagnostic = false;
  for (const line of lines) {
    if (PHP_DIAGNOSTIC_LINE.test(line)) {
      inDiagnostic = true;
      continue;
    }
    if (inDiagnostic) {
      // A blank line or a trace continuation still belongs to the diagnostic;
      // anything else is the command's real output resuming.
      if (!line.trim() || PHP_DIAGNOSTIC_CONT.test(line)) continue;
      inDiagnostic = false;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * The first PHP diagnostic in a buffer, or null. Exists so an error message can
 * name the CAUSE of a polluted read without echoing the buffer itself — which
 * may hold a live credential right after the prose (that is precisely the shape
 * of the app-password bug).
 */
export function firstPhpDiagnostic(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .find((l) => PHP_DIAGNOSTIC_LINE.test(l))
      ?.trim() ?? null
  );
}

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
  const { stdout } = await runPhpCode('echo PHP_VERSION;');
  return stdout.trim();
}

/**
 * `php -r <code>`, with both stdout guards applied once instead of at each call
 * site. Every caller reads a SCALAR out of the result (a version string, a JSON
 * blob), which is exactly the read that broke in issue #1 — see
 * stripPhpDiagnostics. Returns the same {code, stdout, stderr} shape as
 * spawnCapture, so it never throws: check `.code`.
 */
export async function runPhpCode(code) {
  const php = await resolvePhpExe();
  const result = await spawnCapture(php, ['-d', `display_errors=${PHP_DISPLAY_ERRORS}`, '-r', code]);
  return { ...result, stdout: stripPhpDiagnostics(result.stdout) };
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
let verifiedPharThisProcess = false;

export async function ensureWpCli() {
  await mkdir(USR_BIN, { recursive: true });
  // Verify what we EXECUTE, not merely what we download. Pinning the download
  // alone left every machine that ran an earlier version still executing the
  // unverified phar it had already cached — the file is only fetched when
  // absent, so the digest check never ran again. The path is version-scoped
  // and tool-owned so this also cannot clobber (or silently downgrade) a
  // wp-cli the user installed deliberately as `wp-cli.phar`.
  if (!verifiedPharThisProcess) {
    const actual = await readFile(WP_CLI_PHAR, null)
      .then((buf) => createHash('sha512').update(buf).digest('hex'))
      .catch(() => null);
    if (actual !== WP_CLI_SHA512) {
      if (actual !== null) {
        console.log(`  (replacing an unverified ${WP_CLI_PHAR} with the pinned WP-CLI ${WP_CLI_VERSION})`);
      }
      await downloadFile(WP_CLI_URL, WP_CLI_PHAR, { expectedSha512: WP_CLI_SHA512 });
    }
    verifiedPharThisProcess = true;
  }
  const php = await resolvePhpExe();
  const batContent = `@echo off\r\n"${php}" -d memory_limit=512M -d display_errors=${PHP_DISPLAY_ERRORS} "${WP_CLI_PHAR}" %*\r\n`;
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
  const fullArgs = ['-d', 'memory_limit=512M', '-d', `display_errors=${PHP_DISPLAY_ERRORS}`, phar];
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
