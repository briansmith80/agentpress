#!/usr/bin/env node
// The per-site interactive menu. Dependency-free by design (no npm installs
// required to run this) and frozen at scaffold time — the agentpress
// checkout's `update` command is the only thing that refreshes it.
// Apache/MySQL are shared by every Laragon site, always-on, so unlike
// the Docker original this menu never starts or stops anything itself.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const VERSION = '__AGENTPRESS_VERSION__';
const CWD = process.cwd();
const ENV_PATH = join(CWD, '.env');
const LOCK_PATH = join(CWD, '.agentpress.lock');
// Absolute path baked in at scaffold time — usr\bin is only on PATH when
// Laragon's "Add to Path" was applied on this machine, so a bare `wp` is
// not a safe assumption. Falls back to PATH if the file has moved.
// Double-quoted literal on purpose: `'` is legal in Windows paths (a
// user-profile Laragon under O'Brien), `"` is not — so this can never
// break, while a single-quoted literal could.
const WP_BAT = "__WP_BAT_ESCAPED__";
const AGENT_LABELS = { claude: 'Claude Code', cursor: 'Cursor CLI', codex: 'Codex CLI', opencode: 'OpenCode' };
// The registry KEY is not the command. Launching used to pass the key straight
// to the shell, so "Open Cursor CLI" ran `cursor` (a different program, or
// nothing) instead of Cursor's agent binary, and the failure was swallowed.
const AGENT_COMMANDS = { claude: 'claude', cursor: 'cursor-agent', codex: 'codex', opencode: 'opencode' };
// Cursor renamed its CLI command from `cursor-agent` to `agent`
// (cursor.com/docs/cli/installation, checked 2026-08-12), so a machine has
// one or the other depending on install age. Launch probes the old
// unambiguous name first, then the new one — `agent` is too generic to trust
// on name alone, so it only counts when its resolved path looks like
// Cursor's. Deliberate copies of src/agents.mjs's maps (frozen file);
// test/parity.test.mjs pins them together.
const AGENT_COMMAND_FALLBACKS = { cursor: 'agent' };

// --- colour ---
// Declared up here, ahead of the early bails below, so those failure messages
// can use red() too — a bare ✖ here beside a red ✖ from the main CLI is the
// kind of split that makes one product look like two.
// Kept deliberately identical to src/ansi.mjs's gate (this file can't import
// it — see the BANNER_LINES comment further down). Env values are STRINGS, so a
// bare truthiness test would make FORCE_COLOR=0 and NO_COLOR=0 — the
// conventional spellings of "off" — read as ON; and NO_COLOR is checked first
// so an explicit "off" always beats an "on".
const OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);
const envOn = (name) => {
  const v = process.env[name];
  return v !== undefined && !OFF_VALUES.has(String(v).trim().toLowerCase());
};
const COLOR = envOn('NO_COLOR')
  ? false
  : envOn('FORCE_COLOR') || (Boolean(process.stdout.isTTY) && !envOn('CI') && process.env.TERM !== 'dumb');
const PINK = (process.env.COLORTERM || '').includes('truecolor') ? '\x1b[38;2;255;45;120m' : '\x1b[38;5;198m';
const pink = (s) => (COLOR ? `${PINK}${s}\x1b[39m` : s);
const dim = (s) => (COLOR ? `\x1b[2m${s}\x1b[22m` : s);
const red = (s) => (COLOR ? `\x1b[31m${s}\x1b[39m` : s);
// Yellow for a real non-blocking warning, matching the project's status-colour
// rule. The wrong-site notice was rendered in dim — the colour reserved for
// mere information — so the one thing standing between the user and edits to
// the WRONG WordPress looked like trivia beside "one-click login".
const yellow = (s) => (COLOR ? `\x1b[33m${s}\x1b[39m` : s);

if (!existsSync(ENV_PATH)) {
  console.error(`${red('✖')} No .env here — run this from your AgentPress site directory.`);
  process.exit(1);
}

// Split on either line ending: a CRLF-normalised .env (a Notepad "save") made
// every line fail this match — `.` never matches `\r`, and `$` is not in
// multiline mode — leaving the menu with an empty env and no site host.
function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = parseEnv(readFileSync(ENV_PATH, 'utf8'));
let cfg = { agents: [] };
try {
  cfg = JSON.parse(readFileSync(join(CWD, 'sandbox.config.json'), 'utf8'));
} catch {
  // optional file
}

// .env is a file that can be copied between projects or arrive with someone
// else's project, so its values are NOT trusted here: SITE_HOST reaches a
// URL that used to be handed to cmd.exe, where '&' would start a second
// command. Validate, don't sanitise.
function safeHost(value) {
  // `\d`, not a bare `d`: the original character class read `(:d{1,5})?`, which
  // matches a literal "d" repeated — so any SITE_HOST carrying a port was
  // rejected outright and the menu bailed with "not a valid hostname".
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(value || '') ? value : null;
}
const HOST = safeHost(env.SITE_HOST) || 'localhost';
if (env.SITE_HOST && !safeHost(env.SITE_HOST)) {
  console.error(`${red('✖')} Refusing to use SITE_HOST from .env — "${env.SITE_HOST}" is not a valid hostname.`);
  process.exit(1);
}
const SITE = `${env.SITE_SCHEME === 'https' ? 'https' : 'http'}://${HOST}`;

// COLOR/pink/dim/red live above the early bails so those can use them too.
const link = (url) => (process.stdout.isTTY ? pink(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`) : url);

// Block-letter AGENTPRESS. A deliberate copy of src/ansi.mjs's BANNER_LINES,
// not an import — this file is frozen into every scaffolded site, where src/
// does not exist next to it, the same reason ADMIN_LOGIN_PHP below carries
// its own copy of that PHP. The two must be kept in sync. Generated and
// column-measured (49 columns) rather than typed by hand; trailing spaces are
// trimmed so a whitespace-stripping editor or lint hook can't silently
// reshape it — nothing follows on the line, so it renders identically.
const BANNER_LINES = [
  ' ██   ██  ████ █  █ ████ ███  ███  ████  ███  ███',
  '█  █ █    █    ██ █  █   █  █ █  █ █    █    █',
  '████ █ ██ ███  █ ██  █   ███  ███  ███   ██   ██',
  '█  █ █  █ █    █  █  █   █    █ █  █       █    █',
  '█  █  ██  ████ █  █  █   █    █  █ ████ ███  ███',
];
const BANNER_WIDTH = 49;
// Same gate as src/ansi.mjs: an opt-out for anyone who finds it noisy, plus
// automatic suppression wherever colour is off, because five rows of U+2588
// in a piped log file are pure noise.
const SHOW_BANNER = COLOR && !envOn('AGENTPRESS_NO_BANNER');

function openBrowser(url) {
  // envOn for the same reason as every other gate here: AGENTPRESS_NO_OPEN=0 must
  // mean "do open", and bare truthiness made it mean the opposite.
  if (envOn('AGENTPRESS_NO_OPEN') || envOn('KATALYST_NO_OPEN')) {
    console.log(`  ${dim('Open:')} ${url}`);
    return;
  }
  try {
    // rundll32's FileProtocolHandler opens the default browser with the URL as
    // ONE argv entry — no shell parses it, so '&'/'|' can never become operators
    // (cmd /c start did, and libuv only quotes args containing spaces).
    // 'C:\\Windows', not 'C:\Windows' — in a single-quoted JS string `\W` is not
    // a recognised escape, so the backslash was dropped and the fallback
    // resolved to the relative path "C:Windows", breaking the browser launch on
    // any machine where %SystemRoot% is unset.
    spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    }).unref();
  } catch {
    console.log(`  ${dim('Open:')} ${url}`);
  }
}

/** Where a command resolves on PATH, via System32's where.exe (absolute path: bare-name spawn searches the CWD first, and this runs inside a folder agents write to). Null when not found. */
function resolveOnPath(cmd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), [cmd], { shell: false });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] || null : null));
    child.on('error', () => resolve(null));
  });
}

/** The command to launch for an agent key, honouring the rename fallback. Same logic as src/agents.mjs's detectAgents; the generic fallback name only counts when its path looks like Cursor's. */
async function agentLaunchCommand(key) {
  const primary = AGENT_COMMANDS[key] || key;
  const fallbackName = AGENT_COMMAND_FALLBACKS[key];
  if (!fallbackName) return primary;
  if (await resolveOnPath(primary)) return primary;
  const fallback = await resolveOnPath(fallbackName);
  if (fallback && /cursor|[\\/]\.local[\\/]bin[\\/]/i.test(fallback)) return fallbackName;
  return primary;
}

/**
 * The code editor to offer, or null — the menu entry only appears when one is
 * actually installed, like every other detection-driven item. The GUI exe is
 * spawned directly (shell:false, real argv — live-verified with the spaces in
 * "Microsoft VS Code") rather than the `code` .cmd shim, whose shell layer
 * reintroduces the cmd.exe quoting hazards the terminal item already paid
 * for. Standard user-scope and system install paths only; a custom install
 * location simply hides the entry rather than risking a bare-name spawn,
 * which searches the CURRENT DIRECTORY first — and this runs inside a site
 * folder agents write to.
 */
function findCodeEditor() {
  const candidates = [
    process.env.LOCALAPPDATA && { label: 'VS Code', exe: join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') },
    { label: 'VS Code', exe: join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe') },
    process.env.LOCALAPPDATA && { label: 'Cursor', exe: join(process.env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe') },
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c.exe)) return c;
  }
  return null;
}

/** Fire-and-forget window spawn; resolves true only when the process actually started ('spawn' fires), so callers can fall back or name what opened. */
function trySpawnDetached(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts });
    } catch {
      resolve(false);
      return;
    }
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
    child.once('error', () => resolve(false));
  });
}

/**
 * Windows Terminal first — `wt -d <dir>` opens the user's DEFAULT profile,
 * i.e. whatever shell they actually chose, in the site folder. Hardcoding
 * cmd.exe was a field complaint. Detection is attempt-and-fall-back, NOT
 * existsSync: wt.exe is an app-execution alias (a reparse point fs.stat
 * refuses to resolve), so existsSync returns false on machines that have
 * it — verified live here: existsSync false, spawn succeeded. The absolute
 * alias path, never a bare 'wt': bare-name spawn on Windows searches the
 * CURRENT DIRECTORY first, and this runs inside a site folder that agents
 * write to. shell:false passes -d as real argv (no cmd.exe quoting layer).
 *
 * The cmd fallback deliberately has NO `cd /d "<path>"` argument: the new
 * window inherits this process's cwd, which is always the site dir (the menu
 * refuses to start anywhere else) — and that argument's nested quoting
 * printed "The filename, directory name, or volume label syntax is
 * incorrect." at the top of every window it opened, while contributing
 * nothing.
 */
async function openTerminalHere() {
  const wt = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
  if (process.env.LOCALAPPDATA && (await trySpawnDetached(wt, ['-d', CWD], { shell: false }))) {
    return 'Windows Terminal';
  }
  if (await trySpawnDetached('cmd', ['/c', 'start', 'cmd'])) return 'a Command Prompt';
  console.log(`  ${dim('(could not open a terminal — run this yourself:)')} ${pink(`cd ${CWD}`)}`);
  return null;
}

// One-click already-logged-in wp-admin, via the Agent Connector's
// AdminLoginLink ability. Duplicated here (rather than imported) on
// purpose — this file has to stay dependency-free and runnable with zero
// npm installs, so it carries its own small copy of this PHP payload, same
// as create-agentpress's own src/admin-login.mjs and the Docker
// original's three-copy pattern (documented there as intentional).
const ADMIN_LOGIN_PHP = `
$admins = get_users(array('role' => 'administrator', 'number' => 1, 'orderby' => 'ID'));
$u = $admins ? $admins[0] : null;
if (!$u) { fwrite(STDERR, 'no administrator user'); exit(1); }
$cls = 'AgentConnectorForWp\\\\DefaultAbilities\\\\Services\\\\AdminLoginLink';
if (!class_exists($cls)) { fwrite(STDERR, 'abilities plugin (admin login) not active'); exit(1); }
$r = $cls::create($u->ID, 'index.php', 300);
if (is_wp_error($r)) { fwrite(STDERR, $r->get_error_message()); exit(1); }
echo $r['login_url'];
`;

/**
 * Where mysqldump.exe/mysql.exe live. `wp db export/import` shell out to
 * them, and Laragon does NOT put MySQL's bin on PATH unless "Add to Path"
 * was applied — the exact assumption WP_BAT exists for, one binary over.
 * Field-hit on the first real snapshot: "'mysqldump' is not recognized".
 *
 * Resolution order mirrors src/mysql.mjs (its own copy — frozen file): the
 * ACTUALLY-RUNNING mysqld/mariadbd's own directory first, so the dump comes
 * from the server's own version (this matters: the reference machine has
 * both 8.0.30 and 8.4.3 on disk); newest on disk under <laragon>\bin\mysql
 * as the fallback, with the Laragon root derived from the baked wp.bat.
 * Probed once per menu session, only when a `wp db` command runs.
 */
let cachedDbBin;
async function dbClientBinDir() {
  if (cachedDbBin !== undefined) return cachedDbBin;
  cachedDbBin = null;
  const running = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "(Get-CimInstance Win32_Process -Filter \"Name='mysqld.exe' OR Name='mariadbd.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath)",
        ],
        { shell: false },
      );
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out.trim() || null));
    child.on('error', () => resolve(null));
  });
  if (running) {
    const dir = join(running, '..');
    if (existsSync(join(dir, 'mysqldump.exe')) || existsSync(join(dir, 'mariadb-dump.exe'))) {
      cachedDbBin = dir;
      return cachedDbBin;
    }
  }
  try {
    if (existsSync(WP_BAT)) {
      // <root>\usr\bin\wp.bat → <root>\bin\mysql\<version>\bin
      const mysqlRoot = join(WP_BAT, '..', '..', '..', 'bin', 'mysql');
      for (const v of readdirSync(mysqlRoot).sort().reverse()) {
        const bin = join(mysqlRoot, v, 'bin');
        if (existsSync(join(bin, 'mysqldump.exe'))) {
          cachedDbBin = bin;
          return cachedDbBin;
        }
      }
    }
  } catch {
    // no Laragon-shaped tree — PATH is all we have
  }
  return cachedDbBin;
}

/**
 * Spawns the `wp` shim via shell:true — preferring the absolute WP_BAT path
 * baked in at scaffold time (usr\bin may not be on PATH on this machine),
 * falling back to a bare `wp` from PATH. shell:true is needed for the .bat
 * shim, so EVERY dynamic argument the callers pass must arrive pre-quoted:
 * with shell:true Node joins args unquoted into the cmd.exe line, and an
 * unquoted path breaks the moment it contains a space (any "First Last"
 * Windows username). Only paths this file generates itself are ever passed —
 * nothing user-typed reaches this.
 */
async function runWp(args) {
  const env = { ...process.env };
  // Only `wp db …` needs the MySQL client tools; eval-file and friends must
  // not pay the one-time probe (it would lag the first one-click login).
  if (args[0] === 'db') {
    const dbBin = await dbClientBinDir();
    if (dbBin) {
      // Find the real PATH key: Windows env names are case-insensitive and
      // adding a second spelling ("PATH" beside "Path") is undefined behaviour.
      const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
      env[key] = `${dbBin};${env[key] || ''}`;
    }
  }
  return new Promise((resolve) => {
    const wpCmd = existsSync(WP_BAT) ? `"${WP_BAT}"` : 'wp';
    const child = spawn(wpCmd, [...args, `--path="${join(CWD, 'public')}"`], { shell: true, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: null, stdout: '', stderr: err.message }));
  });
}

// Deliberate duplicated copy of src/wp.mjs's stripPhpDiagnostics — this file is
// frozen into every scaffolded site and cannot import from src/. Kept identical
// programmatically (test/parity.test.mjs), not by eye.
//
// PHP's CLI SAPI sends display_errors output to STDOUT, the same stream values
// are read from. WP-CLI 2.12.0 bundles a react/promise that writes `case X;`,
// which PHP 8.5 deprecated, so on 8.5 every `wp` call prints a Deprecated notice
// ahead of its real output — and `2>/dev/null` cannot help. Issue #1: that
// notice went into .mcp.json as the application password (every MCP request
// 401'd) and made this file's one-click login link unparseable, degrading it to
// the plain form with no explanation.
const PHP_DIAGNOSTIC_LINE =
  /^(PHP )?(Deprecated|Notice|Warning|Strict Standards|Fatal error|Parse error|Recoverable fatal error|Catchable fatal error|Unhandled exception):\s/;
const PHP_DIAGNOSTIC_CONT = /^(Stack trace:\s*$|#\d+\s|\s+thrown in .+ on line \d+\s*$)/;

function stripPhpDiagnostics(text) {
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

function runWpEvalFile(phpCode) {
  const tmpFile = join(tmpdir(), `agentpress-eval-${randomBytes(6).toString('hex')}.php`);
  // eval-file needs an actual <?php tag (unlike `wp eval`) — content
  // outside one is literal output, not executed.
  const content = /^\s*<\?php/.test(phpCode) ? phpCode : `<?php\n${phpCode}`;
  writeFileSync(tmpFile, content, 'utf8');
  return runWp(['eval-file', `"${tmpFile}"`]).finally(() => {
    try {
      unlinkSync(tmpFile);
    } catch {
      // best-effort
    }
  });
}

/** Links are one-time — mint fresh on every pick, never cache. Falls back to the plain login form if anything's off (matches the scaffolder's own admin-login.mjs), saying so instead of degrading silently. */
async function adminUrl() {
  const { code, stdout } = await runWpEvalFile(ADMIN_LOGIN_PHP);
  const out = stripPhpDiagnostics(stdout).trim();
  if (code === 0 && /acfw_login=/.test(out)) {
    try {
      const u = new URL(out);
      u.hostname = HOST;
      u.port = '';
      // Force the scheme as well as the host: wp-cli has no $_SERVER['HTTPS'],
      // so the link comes back http:// even for an https site, and following it
      // makes WordPress report http:// as its own address. Same fix as
      // src/admin-login.mjs (this file carries its own copy by design).
      u.protocol = env.SITE_SCHEME === 'https' ? 'https:' : 'http:';
      return u.toString();
    } catch {
      // fall through
    }
  }
  console.log(dim('  (one-click login unavailable — opening the normal login form; credentials are in .env)'));
  return `${SITE}/wp-admin`;
}

// --- database snapshots ---
// A rollback point before letting an AI agent loose on the site. Kept in the
// site itself (gitignored — a dump is the whole site, password hashes
// included) and named by timestamp so "latest" is a lexicographic sort, no
// index file to corrupt.
const SNAPSHOT_DIR = join(CWD, 'snapshots');
function newestSnapshot() {
  try {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter((f) => /^db-.*\.sql$/.test(f))
      .sort()
      .reverse();
    return files[0] || null;
  } catch {
    return null;
  }
}

/**
 * The debug-logging STATE, read from wp-config.php — never inferred from the
 * log file's existence alone. WordPress creates debug.log only on the FIRST
 * logged notice, so "file absent" conflated two opposite states, and a user
 * who had just enabled debug was told logging was off (field report,
 * 2026-08-14). Mirrors core's wp_debug_mode(): WP_DEBUG_LOG of true/'true'/1
 * logs to wp-content/debug.log, any other non-false value IS the log path.
 * Quoted string values count as on ('true' the string is what `wp config set
 * WP_DEBUG true` writes when --raw is forgotten, and PHP treats it truthy).
 * Returns { enabled: true|false|null (config unreadable), path }.
 */
function debugLogState() {
  const fallback = join(CWD, 'public', 'wp-content', 'debug.log');
  let config;
  try {
    config = readFileSync(join(CWD, 'public', 'wp-config.php'), 'utf8');
  } catch {
    return { enabled: null, path: fallback };
  }
  const value = (name) => {
    const m = config.match(new RegExp(`define\\(\\s*['"]${name}['"]\\s*,\\s*([^)]+?)\\s*\\)`, 'i'));
    if (!m) return null;
    return m[1].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  };
  const isOn = (v) => v !== null && v !== '' && v !== 'false' && v !== '0';
  const logValue = value('WP_DEBUG_LOG');
  const enabled = isOn(value('WP_DEBUG')) && isOn(logValue);
  let path = fallback;
  if (enabled && logValue !== 'true' && logValue !== '1') {
    path = isAbsolute(logValue) ? logValue : join(CWD, 'public', logValue);
  }
  return { enabled, path };
}

/**
 * Last lines of a file WITHOUT reading it whole — debug.log on a broken site
 * grows to hundreds of MB, and readFileSync of that inside an interactive
 * menu is a hang, not a feature.
 */
function tailFile(path, { maxBytes = 16384, maxLines = 40 } = {}) {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    return buf
      .toString('utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(-maxLines);
  } catch {
    return [];
  }
}

// --- single-instance lock ---
// Fixed vs. the Docker original: it probed a stale lock's liveness with
// `ps -o tty=,etime=,command=`, which is POSIX-only. On Windows that returns
// nothing, and the original code then treated "no detail" as "assume the
// lock is real" — wedging the menu forever after a crash. process.kill(pid,
// 0) is cross-platform (throws ESRCH if the pid is gone, EPERM if alive but
// not ours), needs no spawn, and has no locale dependency. A wall-clock max
// age guards against PID reuse.
const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
let lockOwned = false;
try {
  const existing = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const age = Date.now() - (existing.startedAt ? Date.parse(existing.startedAt) : 0);
  if (existing.pid !== process.pid && isPidAlive(existing.pid) && age < LOCK_MAX_AGE_MS) {
    console.error(`${red('✖')} Another AgentPress menu (pid ${existing.pid}) already appears to be running here.`);
    process.exit(1);
  }
} catch {
  // no lock, or unreadable — proceed
}
writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
lockOwned = true;
process.on('exit', () => {
  if (lockOwned) {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      // already gone
    }
  }
});

// --- non-interactive short-circuit ---
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.log(`WordPress  ${SITE}`);
  console.log(`Admin      ${SITE}/wp-admin`);
  console.log('Interactive menu needs a terminal. Commands: npm run wp -- <cmd>');
  process.exit(0);
}

/**
 * Hand-rolled arrow-key select — pure readline raw-mode, no dependency.
 * Node's keypress parser handles the same escape sequences regardless of
 * OS, so this needs no Windows-specific branching. Number keys 1-9 jump
 * straight to that option, matching the Docker original's shortcut.
 */
async function choose(message, options) {
  return new Promise((resolve) => {
    let cursor = 0;
    let renderedLines = 0;
    const render = (final) => {
      if (renderedLines > 0) process.stdout.write(`\x1b[${renderedLines}A\x1b[J`);
      // The confirmed choice collapses to ONE line, question and answer
      // together. It used to collapse to two, and because the menu loops,
      // every action deposited an identical two-line block with nothing
      // between them — four "What would you like to do? / > Open WP Admin"
      // pairs stacked into a wall on a real session (operator screenshot,
      // 2026-08-12). One line per round reads as a session log instead.
      const rows = final ? [`${pink('?')} ${message} ${dim('›')} ${options[cursor].label}`] : [`${pink('?')} ${message}`];
      if (!final) {
        rows.push('');
        options.forEach((o, i) => {
          const marker = i === cursor ? pink('>') : ' ';
          const label = i === cursor ? pink(o.label) : o.label;
          rows.push(`${marker} ${label}${o.hint ? `  ${dim(o.hint)}` : ''}`);
        });
      }
      process.stdout.write(`${rows.join('\n')}\n`);
      renderedLines = rows.length;
    };
    const finish = (value, final) => {
      render(final);
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(value);
    };
    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') return finish(null, false);
      if (key.name === 'up' || key.name === 'left' || (key.shift && key.name === 'tab')) {
        cursor = (cursor + options.length - 1) % options.length;
      } else if (key.name === 'down' || key.name === 'right' || key.name === 'tab') {
        cursor = (cursor + 1) % options.length;
      } else if (key.name === 'return') {
        return finish(options[cursor].value, true);
      } else if (key.name === 'escape') {
        return finish(null, false);
      } else if (/^[1-9]$/.test(str || '') && Number(str) <= options.length) {
        cursor = Number(str) - 1;
        return finish(options[cursor].value, true);
      } else if (str === '0') {
        // 0 = Exit, but ONLY when an exit option exists. The obvious
        // "0 selects the last item" is a trap: this same chooser renders the
        // restore confirm, whose last item is Restore — a reflex 0 there
        // would overwrite the database instead of leaving the menu.
        const exitAt = options.findIndex((o) => o.value === 'exit');
        if (exitAt >= 0) {
          cursor = exitAt;
          return finish(options[cursor].value, true);
        }
      }
      render(false);
    };
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
    render(false);
  });
}

/** A deliberate pause so a warning cannot be repainted away by what launches next. */
function pressAnyKey() {
  return new Promise((resolve) => {
    process.stdout.write(`  ${dim('Press any key to continue…')}`);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('keypress', () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n\n');
      resolve();
    });
  });
}

function runInherit(cmd, args = []) {
  return new Promise((resolve) => {
    let child;
    try {
      // Agent CLIs installed by their own native installers are real .exe
      // files (confirmed for Claude Code on this machine) — shell:true is
      // still used here as a pragmatic default since `cmd` is always one of
      // our own small hardcoded set, never user input.
      child = spawn(cmd, args, { cwd: CWD, stdio: 'inherit', shell: true });
    } catch (err) {
      console.log(`  ${dim(`(could not launch ${cmd}: ${err.message})`)}`);
      resolve();
      return;
    }
    // Report instead of swallowing, but do not blame PATH for everything: an
    // agent that ran and then exited non-zero (an error, a cancelled session)
    // or one the user killed is NOT a missing binary, and saying so told people
    // a program they had just used interactively might not be installed.
    // cmd.exe reports "not recognized" as 1 or 9009; a signal gives null.
    child.on('close', (code, signal) => {
      if (signal) resolve();
      else if (code === 1 || code === 9009) console.log(`  ${dim(`(could not run ${cmd} — is it installed and on PATH?)`)}`);
      else if (code) console.log(`  ${dim(`(${cmd} exited with code ${code})`)}`);
      resolve();
    });
    child.on('error', (err) => {
      console.log(`  ${dim(`(could not launch ${cmd}: ${err.message})`)}`);
      resolve();
    });
  });
}

/**
 * Is this site the one the agents' machine-global `wordpress` MCP entry
 * actually points at? Duplicated rather than imported, like everything else in
 * this frozen file. Returns null when it cannot tell (no readable config).
 *
 * Without this the menu launched an agent whose WordPress tools pointed at a
 * DIFFERENT site — the agent would happily read and edit the wrong WordPress,
 * which is worse than not being wired at all.
 */
function wiredHostFor(agentKey) {
  // homedir(), matching src/mcp.mjs's readWiredHostnames exactly — these two
  // must stay in step. USERPROFILE || HOME || '' diverged from it and, with
  // both unset, join('', …) yields a RELATIVE path, so this would have read
  // `<site>\.claude.json` (often a shared git repo) instead of the user's.
  const home = homedir();
  const read = (p) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  };
  // THREE states, not two. Returning null for both "no readable config" and
  // "config is fine but has no wordpress entry" hid the commonest recovery
  // case: destroying a site strips the wiring machine-wide, so every remaining
  // site then had a working config with no entry — and the menu said nothing
  // and launched an agent with no WordPress tools at all.
  //   null    -> cannot tell (no readable config, or codex)
  //   false   -> readable, but nothing is wired
  //   string  -> the hostname it points at
  let config;
  if (agentKey === 'claude') {
    // Per-site first (1.10.0+): this site's own .mcp.json wins inside this
    // folder — project scope beats user scope once approved, spiked live —
    // so when it names a wordpress server it IS the answer. The global file
    // remains the fallback for sites wired before 1.10.0.
    const project = read(join(CWD, '.mcp.json'));
    const projectUrl = project?.mcpServers?.wordpress?.env?.WP_API_URL;
    if (projectUrl) {
      try {
        return new URL(String(projectUrl)).hostname.toLowerCase();
      } catch {
        return false;
      }
    }
    config = read(join(home, '.claude.json'));
  } else if (agentKey === 'cursor') config = read(join(home, '.cursor', 'mcp.json'));
  else if (agentKey === 'opencode') config = read(join(home, '.config', 'opencode', 'opencode.json'));
  else return null; // codex config is TOML we do not parse
  if (!config) return null;
  const url =
    agentKey === 'opencode' ? config.mcp?.wordpress?.environment?.WP_API_URL : config.mcpServers?.wordpress?.env?.WP_API_URL;
  if (!url) return false;
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** True when `a` is a strictly newer semver than `b`. Digit-wise, so 1.10.0 > 1.9.0. */
function isNewerVersion(a, b) {
  const parse = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

async function checkUpdate() {
  // envOn, not bare truthiness: AGENTPRESS_NO_UPDATE_CHECK=0 is the conventional
  // spelling of "off" and used to switch the check OFF anyway, the same trap the
  // colour gate 380 lines above already documents.
  if (envOn('AGENTPRESS_NO_UPDATE_CHECK') || envOn('KATALYST_NO_UPDATE_CHECK')) return null;
  try {
    const res = await fetch('https://registry.npmjs.org/create-agentpress/latest', {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Strictly NEWER, not merely different. `!==` offered a "update" to any site
    // whose pinned version was AHEAD of npm — which is every site scaffolded from a
    // local checkout — and then pinned the OLDER version into the suggested command,
    // i.e. it talked users into downgrading.
    return data.version && isNewerVersion(data.version, VERSION) ? data.version : null;
  } catch {
    return null;
  }
}

if (SHOW_BANNER) {
  const subtitle = `v${VERSION} · AI-agent-ready WordPress`;
  // Right-aligned by measuring the art, never a hardcoded run of spaces, so
  // the subtitle stays flush with the wordmark's right edge when the version
  // string changes length.
  const pad = ' '.repeat(Math.max(0, BANNER_WIDTH - subtitle.length));
  console.log(`\n${BANNER_LINES.map((l) => pink(l)).join('\n')}`);
  console.log(`${pad}${dim(subtitle)}`);
}

console.log(`\n  WordPress  ${link(SITE)}`);
console.log(`  Admin      ${link(`${SITE}/wp-admin`)}`);
console.log(`  Username   ${env.WP_ADMIN_USER || 'admin'}`);
console.log(`  Password   ${env.WP_ADMIN_PASSWORD || '(see .env)'}\n`);

const latestVersion = await checkUpdate();
// The version rides in the banner subtitle now, so the standalone welcome
// line is redundant — except when the banner is suppressed, where dropping it
// would print the version nowhere at all. Kept for exactly that case. The
// Password row's own trailing newline supplies the blank line before the menu
// prompt either way.
if (!SHOW_BANNER) console.log(`Welcome to AgentPress v${VERSION}.\n`);

// Static per session: editors do not appear mid-menu, and existsSync per
// render would be pure waste.
const codeEditor = findCodeEditor();

for (;;) {
  const agents = (cfg.agents || []).filter((a) => AGENT_LABELS[a]);
  // Detection-driven entries: an item appears only when its situation does.
  // "Point MCP here" shows up exactly when some agent's hint above it carries
  // a ⚠ (wiring absent or claimed by another site); "Restore" only once a
  // snapshot exists; "Update this site" only when npm has a newer version.
  // A menu of remedies for problems you don't have is noise.
  let wiringBroken = false;
  const agentOptions = agents.map((a) => {
    const wired = wiredHostFor(a);
    let hint;
    if (wired === false) {
      hint = yellow('⚠ no MCP wiring — run rewire');
      wiringBroken = true;
    } else if (wired && wired !== HOST.toLowerCase()) {
      hint = yellow(`⚠ MCP points at ${wired}`);
      wiringBroken = true;
    } else if (wired) hint = 'MCP points here';
    return { value: `agent:${a}`, label: `Open ${AGENT_LABELS[a]}`, hint };
  });
  const latestSnapshot = newestSnapshot();
  const debug = debugLogState();
  const options = [
    { value: 'admin', label: 'Open WP Admin', hint: 'one-click login' },
    { value: 'site', label: 'Open the site', hint: 'front end' },
    ...agentOptions,
    ...(wiringBroken ? [{ value: 'rewire', label: 'Point MCP here', hint: yellow('⚠ fixes the wiring above') }] : []),
    { value: 'snapshot', label: 'Snapshot the database', hint: 'rollback point before agent sessions' },
    ...(latestSnapshot ? [{ value: 'restore', label: 'Restore the latest snapshot', hint: latestSnapshot }] : []),
    {
      value: 'errors',
      label: 'Show recent errors',
      hint: existsSync(debug.path) ? 'wp-content/debug.log' : debug.enabled ? 'debug on — nothing logged yet' : 'debug logging is off',
    },
    ...(codeEditor ? [{ value: 'editor', label: `Open in ${codeEditor.label}`, hint: 'this site folder' }] : []),
    { value: 'shell', label: 'Open a terminal here' },
    ...(latestVersion ? [{ value: 'update', label: 'Update this site', hint: `v${VERSION} → v${latestVersion}` }] : []),
    { value: 'exit', label: 'Exit' },
  ];
  const choice = await choose('What would you like to do?', options);

  // Every looping action ends with a dim one-line receipt and a blank line.
  // Both exist for the same screenshot: silent actions left nothing but the
  // collapsed prompt behind, so repeated picks fused into a stuttering wall —
  // and the silence itself invited re-picking, since nothing said the click
  // had landed. The receipt never includes the admin URL: the one-click link
  // carries a single-use login token, and tokens are never echoed.
  if (choice === null || choice === 'exit') {
    console.log(`\n${pink(`cd ${CWD} && npm run agentpress`)} ${dim('to come back.')}\n`);
    process.exit(0);
  } else if (choice === 'admin') {
    openBrowser(await adminUrl());
    console.log(`  ${dim('→ opened WP Admin in your browser')}\n`);
  } else if (choice === 'site') {
    openBrowser(SITE);
    console.log(`  ${dim(`→ opened ${SITE} in your browser`)}\n`);
  } else if (choice === 'editor') {
    const ok = await trySpawnDetached(codeEditor.exe, [CWD], { shell: false });
    console.log(ok ? `  ${dim(`→ opened ${codeEditor.label} in this folder`)}\n` : `  ${dim(`(could not launch ${codeEditor.label} — is it still installed?)`)}\n`);
  } else if (choice === 'shell') {
    const opened = await openTerminalHere();
    console.log(opened ? `  ${dim(`→ opened ${opened} in this folder`)}\n` : '');
  } else if (choice === 'rewire') {
    console.log('');
    await runInherit('npx', ['create-agentpress@latest', 'rewire']);
    // No receipt of our own: rewire prints its results, and the menu's own ⚠
    // hints re-read the wiring on the next render — them going quiet IS the
    // confirmation.
    console.log('');
  } else if (choice === 'snapshot') {
    try {
      mkdirSync(SNAPSHOT_DIR, { recursive: true });
      // The folder carries its own ignore file, not just an entry in the
      // site's .gitignore: a site that picked this menu up via `update` may
      // keep its original .gitignore, and a dump is the whole site including
      // password hashes — it must never reach a repo either way.
      const marker = join(SNAPSHOT_DIR, '.gitignore');
      if (!existsSync(marker)) writeFileSync(marker, '*\n');
    } catch {
      // the export below will fail loudly with the real reason
    }
    const name = `db-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
    // FORWARD slashes, both directions. `wp db import` feeds the path to the
    // mysql client inside a SOURCE statement, whose parser reads backslash
    // pairs as client commands — a real C:\laragon\... path died live with
    // "ERROR at line 1: Unknown command '\l'". Export takes either; both get
    // the same shape so the paths in receipts and errors always match.
    const file = join(SNAPSHOT_DIR, name).replace(/\\/g, '/');
    // --add-drop-table so restoring is a clean replace, not a pile of
    // duplicate-key errors on top of the current content.
    const r = await runWp(['db', 'export', `"${file}"`, '--add-drop-table']);
    if (r.code === 0 && existsSync(file)) {
      const mb = (statSync(file).size / (1024 * 1024)).toFixed(1);
      console.log(`  ${dim(`→ database saved to snapshots\\${name} (${mb} MB)`)}\n`);
    } else {
      const reason = (r.stderr || r.stdout || 'wp db export did not run').trim().split('\n')[0];
      console.log(`  ${red('✖')} snapshot failed: ${reason}`);
      // Only reachable when the resolver above found nothing to prepend —
      // the machine has no Laragon-shaped MySQL tree and no tools on PATH.
      if (/not recognized/i.test(reason)) {
        console.log(`  ${dim("mysqldump isn't on PATH and no Laragon MySQL was found — in Laragon:")}`);
        console.log(`  ${dim('right-click menu ▸ Tools ▸ Path ▸ Add Laragon to Path, then retry.')}`);
      }
      console.log('');
    }
  } else if (choice === 'restore') {
    const name = newestSnapshot();
    if (!name) {
      console.log(`  ${dim('(no snapshot found — take one first)')}\n`);
    } else {
      // Cancel is first ON PURPOSE: Enter on a reflex must not overwrite the
      // database. "overwrites", not "replaces ALL": the dump drops and
      // recreates the tables IT contains, so posts/pages/settings/users roll
      // back — but a table some plugin created after the snapshot survives.
      // The hint must not promise a cleaner wipe than wp db import performs.
      const sure = await choose(`Restore ${name} over the current database?`, [
        { value: false, label: 'Cancel' },
        { value: true, label: 'Restore', hint: yellow('overwrites the current WordPress content') },
      ]);
      if (sure) {
        // Forward slashes for the same reason as the export above: mysql's
        // SOURCE parser eats backslash pairs as client commands.
        const r = await runWp(['db', 'import', `"${join(SNAPSHOT_DIR, name).replace(/\\/g, '/')}"`]);
        if (r.code === 0) console.log(`  ${dim(`→ database restored from snapshots\\${name}`)}\n`);
        else {
          const reason = (r.stderr || r.stdout || 'wp db import did not run').trim().split('\n')[0];
          console.log(`  ${red('✖')} restore failed: ${reason}`);
          if (/not recognized/i.test(reason)) {
            console.log(`  ${dim("mysql isn't on PATH and no Laragon MySQL was found — in Laragon:")}`);
            console.log(`  ${dim('right-click menu ▸ Tools ▸ Path ▸ Add Laragon to Path, then retry.')}`);
          }
          console.log('');
        }
      } else {
        console.log('');
      }
    }
  } else if (choice === 'errors') {
    if (!existsSync(debug.path)) {
      // Two OPPOSITE states used to print the same "off" message: WordPress
      // only creates debug.log on the first logged notice, so enabled-but-
      // quiet looked identical to disabled. Field report: a user enabled
      // debug and the menu told them it was off.
      console.log(
        debug.enabled
          ? `\n  ${dim('Debug logging is ON — nothing has been logged yet, which is a healthy sign.')}\n` +
              `  ${dim('The log appears at wp-content/debug.log with the first error or notice.')}\n`
          : `\n  ${dim('No wp-content/debug.log — debug logging is off, which is the healthy default.')}\n` +
              `  ${dim('Turn it on with:')} ${pink('npm run wp -- config set WP_DEBUG true --raw')}\n` +
              `  ${dim('and:')}             ${pink('npm run wp -- config set WP_DEBUG_LOG true --raw')}\n`,
      );
    } else {
      const lines = tailFile(debug.path);
      if (lines.length === 0) {
        console.log(`\n  ${dim('wp-content/debug.log exists but is empty — nothing has gone wrong yet.')}\n`);
      } else {
        console.log(`\n  ${dim(`last ${lines.length} line${lines.length === 1 ? '' : 's'} of wp-content/debug.log:`)}\n`);
        for (const l of lines) console.log(`  ${l}`);
        console.log('');
      }
    }
    await pressAnyKey();
  } else if (choice === 'update') {
    // Pinned to the version the LIVE npm check returned this session — not
    // @latest, which npx can serve from a stale cache right after a release,
    // i.e. the exact moment people pick this item. This is NOT the old
    // frozen-pin downgrade trap (a stale number baked into printed docs):
    // latestVersion is fetched fresh each menu start and this item only
    // exists when it is strictly newer than VERSION, so the pin cannot hand
    // out a stale or older command. Runs it rather than printing it — the
    // operator's ask: the menu already detected the update, so offering a
    // command to retype was friction, not safety (update itself still asks
    // before overwriting files).
    console.log('');
    await runInherit('npx', [`create-agentpress@${latestVersion}`, 'update']);
    // This running menu IS one of the files update refreshes, so the new
    // version only shows after a relaunch. The item stays in the list — a
    // second pick is harmless, and dropping it here would fake certainty this
    // process cannot have about whether the run succeeded.
    console.log(`\n  ${dim('→ update run — restart the menu (npm run agentpress) to load the refreshed files')}\n`);
  } else if (choice.startsWith('agent:')) {
    const key = choice.slice('agent:'.length);
    const wired = wiredHostFor(key);
    // Never launch an agent whose WordPress tools address a DIFFERENT site
    // without stopping first — it would read and edit the wrong WordPress, and
    // the agent's own startup output repaints the terminal immediately, so a
    // printed note alone is not read. Yellow, and it waits for a keypress.
    if (wired === false || (wired && wired !== HOST.toLowerCase())) {
      console.log(
        `\n  ${yellow('⚠')} ${
          wired === false
            ? `No wordpress MCP server is configured for ${AGENT_LABELS[key]}.`
            : `${AGENT_LABELS[key]}'s wordpress MCP server points at ${yellow(wired)}, not ${HOST}.`
        }\n` +
          `  ${dim(
            wired === false
              ? 'Destroying a site removes the wiring machine-wide, which is the usual cause.'
              : 'MCP wiring is machine-wide, so the most recently scaffolded site owns it.',
          )}\n` +
          `  ${dim('Point it at this site with:')} ${pink('npx create-agentpress@latest rewire')}\n` +
          `  ${dim('Launching anyway — the agent will have no WordPress tools for THIS site.')}\n`,
      );
      await pressAnyKey();
    } else if (wired) {
      // Only when the wiring actually points here — /verify tests the MCP path,
      // so offering it while pointed elsewhere would send the user at a check
      // that is designed to fail. Printed rather than prompted: the agent's own
      // startup repaints the terminal, so this is a hint, not an instruction.
      console.log(`\n  ${dim('Tip: run')} ${pink('/verify')} ${dim('inside the agent to test MCP, Playwright and Oxygen end to end.')}\n`);
    }
    await runInherit(await agentLaunchCommand(key));
    // The agent owned the terminal until just now — one blank line keeps its
    // last output from fusing with the next menu round.
    console.log('');
  }
}
