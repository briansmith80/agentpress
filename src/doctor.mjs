// Environment reconnaissance — run before anything else, and re-run after any
// failure. Every fact this prints is one the rest of the tool used to assume
// blindly (which PHP Apache serves with, whether Laragon is even running,
// which of three Node installs is active, ...); doctor makes them explicit.
// Every failure row says what to DO, not just what is wrong, and the run
// ends with a ready-to-scaffold verdict (nonzero exit code when NO) so a
// stranger doesn't have to interpret raw rows.
import { readdir, readFile, stat } from 'node:fs/promises';
import { LARAGON_ROOT, HOSTS_PATH, WWW_DIR, PREMIUM_PLUGINS_DIR } from './paths.mjs';
import { phpVersion, resolvePhpExe, spawnCapture, wpCliPresent } from './wp.mjs';
import { apacheUp, inferHostnameSuffix, laragonRunning, mysqlUp, preflight } from './laragon.mjs';
import { MYSQL_PORT, resolveMysqlClientExe, resolveRootCredential } from './mysql.mjs';
import { psCapture } from './win.mjs';
import { AGENT_LABELS, detectAgents } from './agents.mjs';
import { wildcardActive, wildcardConfInstalled } from './wildcard.mjs';
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
  const row = (label, value) => lines.push(`  ${label.padEnd(26)}  ${value}`);
  const blocked = (label, value, why) => {
    row(label, value);
    blockers.push(why);
  };

  lines.push('Laragon / environment check\n');

  if (await exists(LARAGON_ROOT)) {
    row('Laragon root', LARAGON_ROOT);
  } else {
    blocked(
      'Laragon root',
      `${LARAGON_ROOT} — NOT FOUND. If Laragon lives elsewhere, set AGENTPRESS_LARAGON_ROOT to its folder.`,
      'Laragon root not found',
    );
  }

  const state = await preflight();
  row('laragon.exe process', state.laragonRunning ? 'running' : 'NOT running — start Laragon first');
  if (!state.laragonRunning) blockers.push('Laragon is not running');

  if (state.webServer === 'apache') {
    row('Web server', 'Apache (httpd.exe) — supported');
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
  row('TCP :80 (web server)', state.apacheUp ? 'listening' : 'closed — click Start All in Laragon');

  if (!wildcardConfInstalled()) {
    row('Instant mode', 'off — run `setup` once to enable instant scaffolds (no Laragon reloads)');
  } else if (state.apacheUp && (await wildcardActive())) {
    row('Instant mode', 'ACTIVE — scaffolds skip Laragon reloads entirely');
  } else {
    row('Instant mode', 'installed but not live yet — one-time Stop All → Start All in Laragon, then re-run setup to confirm');
  }
  row(`TCP :${MYSQL_PORT} (MySQL)`, state.mysqlUp ? 'listening' : `closed — click Start All in Laragon${MYSQL_PORT === 3306 ? ' (moved MySQL? set AGENTPRESS_MYSQL_PORT)' : ''}`);
  if (!state.mysqlUp) blockers.push('MySQL is not running');

  try {
    const php = await resolvePhpExe();
    const version = await phpVersion();
    row('PHP (Apache serves with)', `${php}  (v${version})`);
    const ini = await phpIniSummary();
    if (ini) {
      row('  memory_limit', ini.memory_limit);
      row('  upload/post max', `${ini.upload_max_filesize} / ${ini.post_max_size} (effective cap = the smaller)`);
      row('  SMTP', `${ini.SMTP || '(unset)'}:${ini.smtp_port || ''} — mail needs Mailpit at 127.0.0.1:1025, or a mail plugin`);
      row('  exif extension', ini.exif ? 'enabled' : 'NOT enabled (WP Site Health will note this; harmless for most sites)');
    }
  } catch (err) {
    blocked('PHP', `could not resolve — ${err.message}`, 'no PHP found under Laragon');
  }

  const nodePath = await nodeOnPath();
  row('Node (running this CLI)', `${process.execPath}  (${process.version})`);
  if (nodePath && nodePath.toLowerCase() !== process.execPath.toLowerCase()) {
    row('  Node on PATH', `${nodePath} — DIFFERS from the Node running this CLI (nvm/version-manager drift)`);
  }

  row('WP-CLI', (await wpCliPresent()) ? `installed (${join(LARAGON_ROOT, 'usr', 'bin', 'wp-cli.phar')})` : 'not installed yet — the first scaffold downloads it automatically');

  const suffix = await inferHostnameSuffix();
  row('Hostname suffix', `${suffix.suffix}  (${suffix.votes ?? 0}/${suffix.sample ?? 0} existing vhosts agree${suffix.sample === 0 ? ' — fresh install, .test assumed' : ''})`);

  const magicCount = await hostsMagicCount();
  row('hosts entries (Laragon)', magicCount === null ? 'could not read hosts file (run doctor as admin to check, or ignore — scaffold will prompt)' : `${magicCount} "#laragon magic!" lines`);

  row('Defender real-time protection', await defenderRealtime());

  const sites = await existingSiteNames();
  row('Existing sites in www\\', `${sites.length} folders`);

  const agents = await detectAgents();
  const agentLines = Object.entries(agents).map(([key, path]) => `${AGENT_LABELS[key]}: ${path || 'not found'}`);
  row('AI agent CLIs', agentLines.join('  |  '));
  if (Object.values(agents).some(Boolean)) {
    const prefix = await npmGlobalPrefix();
    const execDir = process.execPath.replace(/\\[^\\]+$/, '');
    if (prefix && prefix.toLowerCase() !== execDir.toLowerCase()) {
      row('  npm global installs', `land in ${prefix} — switching Node versions can silently lose them`);
    }
  }

  const gh = await spawnCapture('gh', ['--version']);
  row(
    'GitHub CLI (gh)',
    gh.code === 0
      ? `${gh.stdout.split('\n')[0].trim()} — premium plugin sync available`
      : `not found — optional; premium plugins fall back to zips in ${PREMIUM_PLUGINS_DIR}`,
  );

  if (state.mysqlUp) {
    try {
      const mysqlExe = await resolveMysqlClientExe();
      row('MySQL client', mysqlExe);
      const cred = await resolveRootCredential();
      if (cred) {
        row('MySQL root credential', `resolved (${cred.source})`);
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
    lines.push('  Ready to scaffold: YES');
    lines.push('');
    if (!wildcardConfInstalled()) {
      lines.push(`  Next: run \`${cli} setup\` once (plugin zips, license key, instant mode), then \`${cli} <name>\` to scaffold.`);
    } else {
      lines.push(`  Next: \`${cli} <name>\` to scaffold a site.`);
    }
    lines.push(`  All commands: ${cli} help`);
  } else {
    lines.push(`  Ready to scaffold: NO — fix first: ${blockers.join('; ')}`);
    lines.push('');
    lines.push(`  Fix the items above, then re-run \`${cli} doctor\`. All commands: ${cli} help`);
    process.exitCode = 1;
  }
  lines.push('');

  console.log(lines.join('\n'));
}
