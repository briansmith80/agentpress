#!/usr/bin/env node
// The per-site interactive menu. Dependency-free by design (no npm installs
// required to run this) and frozen at scaffold time — the agentpress
// checkout's `update` command is the only thing that refreshes it.
// Apache/MySQL are shared by every Laragon site, always-on, so unlike
// the Docker original this menu never starts or stops anything itself.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { emitKeypressEvents } from 'node:readline';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

if (!existsSync(ENV_PATH)) {
  console.error(`${red('✖')} No .env here — run this from your agentpress site directory.`);
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
  if ((process.env.AGENTPRESS_NO_OPEN ?? process.env.KATALYST_NO_OPEN)) {
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

function openTerminalHere() {
  try {
    spawn('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${CWD}"`], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log(`  cd ${CWD}`);
  }
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
 * Spawns the `wp` shim via shell:true — preferring the absolute WP_BAT path
 * baked in at scaffold time (usr\bin may not be on PATH on this machine),
 * falling back to a bare `wp` from PATH. That's the one place in this file
 * that needs shell:true rather than a direct .exe spawn — but the only
 * dynamic argument is a temp-file path we generate ourselves, nothing
 * untrusted, so the cmd.exe quoting risk that matters elsewhere doesn't
 * apply here.
 */
function runWpEvalFile(phpCode) {
  return new Promise((resolve) => {
    const tmpFile = join(tmpdir(), `agentpress-eval-${randomBytes(6).toString('hex')}.php`);
    // eval-file needs an actual <?php tag (unlike `wp eval`) — content
    // outside one is literal output, not executed.
    const content = /^\s*<\?php/.test(phpCode) ? phpCode : `<?php\n${phpCode}`;
    writeFileSync(tmpFile, content, 'utf8');
    const wpCmd = existsSync(WP_BAT) ? `"${WP_BAT}"` : 'wp';
    // Every dynamic arg is quoted: with shell:true Node joins args unquoted
    // into the cmd.exe line, so an unquoted tmp path breaks the moment TEMP
    // contains a space (any "First Last" Windows username). wp-cli parses
    // quoted --path="..." fine.
    const child = spawn(wpCmd, ['eval-file', `"${tmpFile}"`, `--path="${join(CWD, 'public')}"`], { shell: true });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => {
      try {
        unlinkSync(tmpFile);
      } catch {
        // best-effort
      }
      resolve({ code, stdout });
    });
    child.on('error', () => resolve({ code: null, stdout: '' }));
  });
}

/** Links are one-time — mint fresh on every pick, never cache. Falls back to the plain login form if anything's off (matches the scaffolder's own admin-login.mjs), saying so instead of degrading silently. */
async function adminUrl() {
  const { code, stdout } = await runWpEvalFile(ADMIN_LOGIN_PHP);
  const out = stdout.trim();
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
    console.error(`${red('✖')} Another agentpress menu (pid ${existing.pid}) already appears to be running here.`);
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
      const rows = [`${pink('?')} ${message}`];
      if (final) {
        rows.push(`${dim('>')} ${options[cursor].label}`);
      } else {
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

function runInherit(cmd, args = []) {
  return new Promise((resolve) => {
    let child;
    try {
      // Agent CLIs installed by their own native installers are real .exe
      // files (confirmed for Claude Code on this machine) — shell:true is
      // still used here as a pragmatic default since `cmd` is always one of
      // our own small hardcoded set, never user input.
      child = spawn(cmd, args, { cwd: CWD, stdio: 'inherit', shell: true });
    } catch {
      resolve();
      return;
    }
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

async function checkUpdate() {
  if ((process.env.AGENTPRESS_NO_UPDATE_CHECK ?? process.env.KATALYST_NO_UPDATE_CHECK)) return null;
  try {
    const res = await fetch('https://registry.npmjs.org/create-agentpress/latest', {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.version && data.version !== VERSION ? data.version : null;
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
if (!SHOW_BANNER) console.log(`Welcome to agentpress v${VERSION}.\n`);

for (;;) {
  const agents = (cfg.agents || []).filter((a) => AGENT_LABELS[a]);
  const options = [
    { value: 'admin', label: 'Open WP Admin', hint: 'one-click login' },
    { value: 'site', label: 'Open the site', hint: 'front end' },
    ...agents.map((a) => ({ value: `agent:${a}`, label: `Open ${AGENT_LABELS[a]}` })),
    { value: 'shell', label: 'Open a terminal here' },
    ...(latestVersion ? [{ value: 'update', label: 'Update agentpress', hint: `v${VERSION} → v${latestVersion}` }] : []),
    { value: 'exit', label: 'Exit' },
  ];
  const choice = await choose('What would you like to do?', options);

  if (choice === null || choice === 'exit') {
    console.log(`\n${dim('cd')} ${CWD} ${dim('&& npm run agentpress')} to come back.\n`);
    process.exit(0);
  } else if (choice === 'admin') {
    openBrowser(await adminUrl());
  } else if (choice === 'site') {
    openBrowser(SITE);
  } else if (choice === 'shell') {
    openTerminalHere();
  } else if (choice === 'update') {
    console.log(`  Run: npx create-agentpress@${latestVersion} update   (from this directory)`);
  } else if (choice.startsWith('agent:')) {
    await runInherit(choice.slice('agent:'.length));
  }
}
