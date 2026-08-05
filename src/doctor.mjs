// Environment reconnaissance — run before anything else, and re-run after any
// failure. Every fact this prints is one the rest of the tool used to assume
// blindly (which PHP Apache serves with, whether Laragon is even running,
// which of three Node installs is active, ...); doctor makes them explicit.
// Every failure row says what to DO, not just what is wrong, and the run
// ends with a ready-to-scaffold verdict (nonzero exit code when NO) so a
// stranger doesn't have to interpret raw rows.
//
// Colour and the status glyphs come from ./ansi.mjs (zero-dependency), and
// every row carries a status so the glyph column can be scanned without
// reading a word. EDITORS: ANSI escapes count toward String.length, so pad
// the RAW label and colour afterwards — `green(label).padEnd(26)` silently
// loses 9 columns of alignment. `row()` is the only place that does either.
import { readdir, readFile, stat } from 'node:fs/promises';
import { LARAGON_ROOT, HOSTS_PATH, WWW_DIR, PREMIUM_PLUGINS_DIR } from './paths.mjs';
import { phpVersion, resolvePhpExe, spawnCapture, wpCliPresent } from './wp.mjs';
import { apacheUp, inferHostnameSuffix, laragonRunning, mysqlUp, preflight, sslPortUp } from './laragon.mjs';
import { MYSQL_PORT, resolveMysqlClientExe, resolveRootCredential } from './mysql.mjs';
import { psCapture } from './win.mjs';
import { AGENT_LABELS, detectAgents } from './agents.mjs';
import { readWiredHostnames } from './mcp.mjs';
import { sslCertPresent, wildcardActive, wildcardConfInstalled } from './wildcard.mjs';
import { bold, dim, green, mark, red, tint } from './ansi.mjs';
import { join } from 'node:path';

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function nodeOnPath() {
  const { stdout } = await psCapture('(Get-Command node -ErrorAction SilentlyContinue).Source');
  return stdout.trim() || null;
}

async function npmGlobalPrefix() {
  const { code, stdout } = await psCapture('npm prefix -g');
  if (code !== 0) return null;
  return stdout.trim() || null;
}

async function defenderRealtime() {
  const { code, stdout } = await psCapture('(Get-MpComputerStatus -ErrorAction Stop).RealTimeProtectionEnabled');
  if (code !== 0) return 'unknown (needs elevation to query, or Defender absent)';
  const v = stdout.trim();
  if (v === 'True') return 'on (first scaffold may be slower while new files are scanned — normal)';
  if (v === 'False') return 'off';
  return 'unknown';
}

async function hostsMagicCount() {
  try {
    const content = await readFile(HOSTS_PATH, 'utf8');
    return content.split('\n').filter((l) => l.includes('#laragon magic!')).length;
  } catch {
    return null;
  }
}

async function phpIniSummary() {
  const php = await resolvePhpExe();
  const code =
    "echo json_encode(['memory_limit'=>ini_get('memory_limit'),'upload_max_filesize'=>ini_get('upload_max_filesize'),'post_max_size'=>ini_get('post_max_size'),'SMTP'=>ini_get('SMTP'),'smtp_port'=>ini_get('smtp_port'),'exif'=>extension_loaded('exif')?1:0,'ini_path'=>php_ini_loaded_file()]);";
  const { code: exitCode, stdout } = await spawnCapture(php, ['-r', code]);
  if (exitCode !== 0) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * php.ini shorthand ("256M", "8M", "1G", "-1") to bytes. `-1` means unlimited
 * and returns null, same as an unparseable value — both mean "no judgement to
 * make", which is what the callers treat null as.
 */
function parsePhpBytes(value) {
  const m = String(value ?? '').trim().match(/^(\d+)\s*([KMG])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] || '').toLowerCase()] ?? 1;
  return n * mult;
}

async function existingSiteNames() {
  try {
    const entries = await readdir(WWW_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function runDoctor({ cli = 'node index.js' } = {}) {
  const lines = [];
  const blockers = [];
  // Pad the RAW label, then colour — the escapes in a coloured string count
  // toward padEnd's width and would eat the column alignment.
  // LABEL_WIDTH must stay >= the longest label ('Defender real-time protection',
  // 29) or that one row's value column hangs to the right of every other row's,
  // which is exactly the alignment this glyph table exists to provide.
  const LABEL_WIDTH = 30;
  const row = (label, value, status = 'info') =>
    lines.push(`  ${mark(status)} ${label.padEnd(LABEL_WIDTH)}  ${tint(status, value)}`);
  const blocked = (label, value, why) => {
    row(label, value, 'bad');
    blockers.push(why);
  };

  lines.push('Laragon / environment check\n');

  if (await exists(LARAGON_ROOT)) {
    row('Laragon root', LARAGON_ROOT, 'ok');
  } else {
    blocked(
      'Laragon root',
      `${LARAGON_ROOT} — NOT FOUND. If Laragon lives elsewhere, set AGENTPRESS_LARAGON_ROOT to its folder.`,
      'Laragon root not found',
    );
  }

  const state = await preflight();
  row(
    'laragon.exe process',
    state.laragonRunning ? 'running' : 'NOT running — start Laragon first',
    state.laragonRunning ? 'ok' : 'bad',
  );
  if (!state.laragonRunning) blockers.push('Laragon is not running');

  if (state.webServer === 'apache') {
    row('Web server', 'Apache (httpd.exe) — supported', 'ok');
  } else if (state.webServer === 'nginx') {
    blocked(
      'Web server',
      'NGINX — not supported. Switch to Apache in Laragon (Menu ▸ Apache, or Preferences ▸ Services & Ports).',
      'Laragon is in Nginx mode (Apache required)',
    );
  } else if (state.webServer === 'foreign') {
    blocked(
      'Web server',
      "something OTHER than Laragon's Apache owns port 80 (IIS?) — stop it or move it off :80.",
      'a non-Laragon service owns port 80',
    );
  } else {
    blocked('Web server', 'nothing listening on :80 — click Start All in Laragon.', 'Apache is not running');
  }
  row(
    'TCP :80 (web server)',
    state.apacheUp ? 'listening' : 'closed — click Start All in Laragon',
    state.apacheUp ? 'ok' : 'bad',
  );

  // Why these three rows exist: the scheme a scaffolded site reports is NOT
  // hardcoded — wp-config.php derives WP_HOME/WP_SITEURL per request from
  // $_SERVER['HTTPS'] (see src/wordpress.mjs), and engine.js only picks https at
  // scaffold time when a live TLS probe succeeds. So a site showing http:// means
  // SSL wasn't live when it was scaffolded, which used to be invisible here.
  // Status here is CONDITIONAL, not just cert/port present-or-not, because "SSL
  // is simply not enabled" is a normal, fully-supported setup — not a warning.
  // Flagging it yellow made a healthy SSL-less machine print four ⚠ directly
  // above "Ready to scaffold: YES", which teaches the reader to ignore yellow.
  // Yellow is reserved for the genuinely odd combination: a cert exists but
  // :443 isn't serving it.
  const sslPort = await sslPortUp();
  const certPresent = sslCertPresent();
  row(
    'TCP :443 (SSL)',
    sslPort ? 'listening' : 'closed — normal if SSL is not enabled in Laragon; http scaffolds work fine',
    sslPort ? 'ok' : certPresent ? 'warn' : 'info',
  );
  row(
    'SSL certificate',
    certPresent
      ? "Laragon's laragon.crt/.key pair found — https is available"
      : "not found — https is off. Enable SSL in Laragon's menu, then re-run `setup` to add the https half of the wildcard vhost",
    certPresent ? 'ok' : 'info',
  );
  // Conditional because wildcardActive({tls}) creates and deletes a real probe
  // folder under www\ and costs a request: without cert + open :443 + conf on
  // disk it can only fail, and would report a "problem" the two rows above have
  // already explained better.
  if (certPresent && sslPort && wildcardConfInstalled()) {
    const httpsLive = await wildcardActive({ tls: true });
    row(
      'https through wildcard',
      httpsLive
        ? 'https is serving — new scaffolds will report https:// URLs'
        : 'conf on disk but the running Apache predates it — one-time Stop All → Start All in Laragon (not just Reload)',
      httpsLive ? 'ok' : 'warn',
    );
  }

  if (!wildcardConfInstalled()) {
    row('Instant mode', 'off — run `setup` once to enable instant scaffolds (no Laragon reloads)', 'warn');
  } else if (state.apacheUp && (await wildcardActive())) {
    row('Instant mode', 'ACTIVE — scaffolds skip Laragon reloads entirely', 'ok');
  } else {
    row(
      'Instant mode',
      'installed but not live yet — one-time Stop All → Start All in Laragon (not just Reload), then re-run setup to confirm',
      'warn',
    );
  }
  row(
    `TCP :${MYSQL_PORT} (MySQL)`,
    state.mysqlUp ? 'listening' : `closed — click Start All in Laragon${MYSQL_PORT === 3306 ? ' (moved MySQL? set AGENTPRESS_MYSQL_PORT)' : ''}`,
    state.mysqlUp ? 'ok' : 'bad',
  );
  if (!state.mysqlUp) blockers.push('MySQL is not running');

  try {
    const php = await resolvePhpExe();
    const version = await phpVersion();
    row('PHP (Apache serves with)', `${php}  (v${version})`, 'ok');
    const ini = await phpIniSummary();
    if (ini) {
      // These two rows used to print a bare number at 'info', which hid a real
      // trap: post_max_size SILENTLY caps uploads below upload_max_filesize, so
      // "50M / 8M" means the actual ceiling is 8M and a 9M media upload just
      // fails. The row already explained the rule in its own parenthetical and
      // then passed no judgement on it — that is a problem marked as trivia.
      const mem = parsePhpBytes(ini.memory_limit);
      row(
        '  memory_limit',
        mem !== null && mem < 256 * 1024 * 1024 ? `${ini.memory_limit} — low for a builder like Oxygen; 256M+ recommended` : ini.memory_limit,
        mem !== null && mem < 256 * 1024 * 1024 ? 'warn' : 'info',
      );
      const upload = parsePhpBytes(ini.upload_max_filesize);
      const post = parsePhpBytes(ini.post_max_size);
      const postCaps = upload !== null && post !== null && post < upload;
      row(
        '  upload/post max',
        postCaps
          ? `${ini.upload_max_filesize} / ${ini.post_max_size} — post_max_size is SMALLER, so the real upload ceiling is ${ini.post_max_size}`
          : `${ini.upload_max_filesize} / ${ini.post_max_size} (effective cap = the smaller)`,
        postCaps ? 'warn' : 'info',
      );
      row('  SMTP', `${ini.SMTP || '(unset)'}:${ini.smtp_port || ''} — mail needs Mailpit at 127.0.0.1:1025, or a mail plugin`, 'info');
      // 'info', not 'warn', when absent: the row's own text says "harmless for
      // most sites", and a glyph that contradicts its own sentence is noise.
      row(
        '  exif extension',
        ini.exif ? 'enabled' : 'NOT enabled (WP Site Health will note this; harmless for most sites)',
        ini.exif ? 'ok' : 'info',
      );
    }
  } catch (err) {
    blocked('PHP', `could not resolve — ${err.message}`, 'no PHP found under Laragon');
  }

  const nodePath = await nodeOnPath();
  row('Node (running this CLI)', `${process.execPath}  (${process.version})`, 'info');
  if (nodePath && nodePath.toLowerCase() !== process.execPath.toLowerCase()) {
    row('  Node on PATH', `${nodePath} — DIFFERS from the Node running this CLI (nvm/version-manager drift)`, 'warn');
  }

  // 'info', not 'warn', when absent: the first scaffold installs it, so a missing
  // wp-cli.phar is a step that hasn't run yet, not something to fix.
  const wpCli = await wpCliPresent();
  row(
    'WP-CLI',
    wpCli ? `installed (${join(LARAGON_ROOT, 'usr', 'bin', 'wp-cli.phar')})` : 'not installed yet — the first scaffold downloads it automatically',
    wpCli ? 'ok' : 'info',
  );

  const suffix = await inferHostnameSuffix();
  row('Hostname suffix', `${suffix.suffix}  (${suffix.votes ?? 0}/${suffix.sample ?? 0} existing vhosts agree${suffix.sample === 0 ? ' — fresh install, .test assumed' : ''})`, 'info');

  const magicCount = await hostsMagicCount();
  row(
    'hosts entries (Laragon)',
    magicCount === null ? 'could not read hosts file (run doctor as admin to check, or ignore — scaffold will prompt)' : `${magicCount} "#laragon magic!" lines`,
    // 'info' even when unreadable: the text itself says "or ignore", and the
    // scaffold prompts for it anyway. A yellow glyph beside copy that grants
    // permission to ignore it is the definition of crying wolf.
    'info',
  );

  row('Defender real-time protection', await defenderRealtime(), 'info');

  const sites = await existingSiteNames();
  row('Existing sites in www\\', `${sites.length} folders`, 'info');

  const agents = await detectAgents();
  const anyAgent = Object.values(agents).some(Boolean);
  // Only list the agents actually FOUND. The old row printed every candidate
  // including "not found" ones and tinted the whole string green, so three
  // "not found"s rendered as if they were successes. 'info' rather than 'warn'
  // when none are present: agent CLIs are optional and this tool never installs
  // them (README says so) — same reasoning as the WP-CLI row above.
  const found = Object.entries(agents).filter(([, path]) => path);
  row(
    'AI agent CLIs',
    anyAgent
      ? found.map(([key, path]) => `${AGENT_LABELS[key]}: ${path}`).join('  |  ')
      : 'none found — scaffolding works, it just skips MCP wiring (install Claude Code, Cursor, Codex or OpenCode to get it)',
    anyAgent ? 'ok' : 'info',
  );
  if (anyAgent) {
    row(
      '  MCP servers',
      "BOTH are wired automatically for every scaffolded site — wordpress (the site's REST API) and playwright (browser automation); no separate install step",
      'info',
    );
    // Read the wiring back rather than asserting it. The entry is
    // machine-global and the newest scaffold wins, so "which site am I actually
    // pointed at?" is a real question a user cannot otherwise answer — and
    // getting it wrong means an agent silently edits the wrong site.
    const wired = await readWiredHostnames();
    const targets = [...new Set(Object.values(wired).filter(Boolean))];
    if (!Object.keys(wired).length) {
      row('  MCP target', 'no agent config readable yet — scaffold a site (or run `rewire` in one) to wire it', 'info');
    } else if (!targets.length) {
      row('  MCP target', 'no wordpress MCP entry is configured — run `rewire` from a site folder to point agents at it', 'warn');
    } else {
      row(
        '  MCP target',
        `${targets.join(', ')}${targets.length > 1 ? ' (agents disagree)' : ''} — this is the ONLY site agents can reach; run \`rewire\` in another site's folder to switch`,
        'info',
      );
    }
    const prefix = await npmGlobalPrefix();
    const execDir = process.execPath.replace(/\\[^\\]+$/, '');
    if (prefix && prefix.toLowerCase() !== execDir.toLowerCase()) {
      row('  npm global installs', `land in ${prefix} — switching Node versions can silently lose them`, 'warn');
    }
  }

  const gh = await spawnCapture('gh', ['--version']);
  row(
    'GitHub CLI (gh)',
    gh.code === 0
      ? `${gh.stdout.split('\n')[0].trim()} — premium plugin sync available`
      : `not found — optional; premium plugins fall back to zips in ${PREMIUM_PLUGINS_DIR}`,
    gh.code === 0 ? 'ok' : 'info',
  );

  if (state.mysqlUp) {
    try {
      const mysqlExe = await resolveMysqlClientExe();
      row('MySQL client', mysqlExe, 'ok');
      const cred = await resolveRootCredential();
      if (cred) {
        row('MySQL root credential', `resolved (${cred.source})`, 'ok');
      } else {
        blocked(
          'MySQL root credential',
          'could not resolve — set AGENTPRESS_MYSQL_ROOT_PASSWORD to your MySQL root password and retry',
          'MySQL root credential unknown',
        );
      }
    } catch (err) {
      blocked('MySQL client', `could not resolve — ${err.message}`, 'no MySQL client found under Laragon');
    }
  }

  lines.push('');
  if (blockers.length === 0) {
    lines.push(`  ${mark('ok')} ${bold(green('Ready to scaffold: YES'))}`);
    lines.push('');
    if (!wildcardConfInstalled()) {
      lines.push(`  ${mark('step')} Next: run \`${cli} setup\` once (plugin zips, license key, instant mode), then \`${cli} <name>\` to scaffold.`);
    } else {
      lines.push(`  ${mark('step')} Next: \`${cli} <name>\` to scaffold a site.`);
    }
    // Two spaces of filler where the glyph would go, so this closing line stays
    // flush with the column above it instead of hanging a glyph-width left.
    lines.push(`    ${dim(`All commands: ${cli} help`)}`);
  } else {
    lines.push(`  ${mark('bad')} ${bold(red(`Ready to scaffold: NO — fix first: ${blockers.join('; ')}`))}`);
    lines.push('');
    lines.push(`  ${mark('step')} Fix the items above, then re-run \`${cli} doctor\`.`);
    lines.push(`    ${dim(`All commands: ${cli} help`)}`);
    process.exitCode = 1;
  }
  lines.push('');

  console.log(lines.join('\n'));
}
