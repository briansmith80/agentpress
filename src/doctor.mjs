// Environment reconnaissance — run before anything else, and re-run after any
// failure. Every fact this prints is one the rest of the tool used to assume
// blindly (which PHP Apache serves with, whether Laragon is even running,
// which of three Node installs is active, ...); doctor makes them explicit.
import { readdir, readFile, stat } from 'node:fs/promises';
import { LARAGON_ROOT, HOSTS_PATH, WWW_DIR } from './paths.mjs';
import { phpVersion, resolvePhpExe, spawnCapture, wpCliPresent } from './wp.mjs';
import { apacheUp, inferHostnameSuffix, laragonRunning, mysqlUp } from './laragon.mjs';
import { processRunning, psCapture } from './win.mjs';
import { resolveMysqlClientExe, resolveRootCredential } from './mysql.mjs';
import { AGENT_LABELS, detectAgents } from './agents.mjs';
import { join } from 'node:path';

const BASH_EXE = join(LARAGON_ROOT, 'bin', 'git', 'bin', 'bash.exe');

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

async function defenderRealtime() {
  const { code, stdout } = await psCapture('(Get-MpComputerStatus -ErrorAction Stop).RealTimeProtectionEnabled');
  if (code !== 0) return 'unknown (needs elevation to query, or Defender absent)';
  const v = stdout.trim();
  if (v === 'True') return 'on';
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

export async function runDoctor() {
  const lines = [];
  const row = (label, value) => lines.push(`  ${label.padEnd(26)}  ${value}`);

  lines.push('Laragon / environment check\n');

  row('Laragon root', (await exists(LARAGON_ROOT)) ? LARAGON_ROOT : `${LARAGON_ROOT} — NOT FOUND`);

  const [laragonUp, httpdUp, apache80, mysql3306] = await Promise.all([
    laragonRunning(),
    processRunning('httpd'),
    apacheUp(),
    mysqlUp(),
  ]);
  row('laragon.exe process', laragonUp ? 'running' : 'NOT running — start Laragon first');
  row('httpd.exe process', httpdUp ? 'running' : 'NOT running');
  row('TCP :80 (Apache)', apache80 ? 'listening' : 'closed');
  row('TCP :3306 (MySQL)', mysql3306 ? 'listening' : 'closed');

  try {
    const php = await resolvePhpExe();
    const version = await phpVersion();
    row('PHP (Apache serves with)', `${php}  (v${version})`);
    const ini = await phpIniSummary();
    if (ini) {
      row('  memory_limit', ini.memory_limit);
      row('  upload/post max', `${ini.upload_max_filesize} / ${ini.post_max_size} (effective cap = the smaller)`);
      row('  SMTP', `${ini.SMTP || '(unset)'}:${ini.smtp_port || ''} — should point at Mailpit 127.0.0.1:1025`);
      row('  exif extension', ini.exif ? 'enabled' : 'NOT enabled (WP Site Health will note this)');
    }
  } catch (err) {
    row('PHP', `could not resolve — ${err.message}`);
  }

  const nodePath = await nodeOnPath();
  row('Node (running this CLI)', `${process.execPath}  (${process.version})`);
  if (nodePath && nodePath.toLowerCase() !== process.execPath.toLowerCase()) {
    row('  Node on PATH', `${nodePath} — DIFFERS from the Node running this CLI (nvm/version-manager drift)`);
  }

  row('WP-CLI', (await wpCliPresent()) ? 'installed (C:\\laragon\\usr\\bin\\wp-cli.phar)' : 'NOT installed yet — run once to install');
  row('Git Bash', (await exists(BASH_EXE)) ? BASH_EXE : 'NOT found (expected for .sh setup-script dispatch)');

  const suffix = await inferHostnameSuffix();
  row('Hostname suffix', `${suffix.suffix}  (${suffix.votes ?? 0}/${suffix.sample ?? 0} existing vhosts agree)`);

  const magicCount = await hostsMagicCount();
  row('hosts entries (Laragon)', magicCount === null ? 'could not read hosts file' : `${magicCount} "#laragon magic!" lines`);

  row('Defender real-time protection', await defenderRealtime());

  const sites = await existingSiteNames();
  row('Existing sites in www\\', `${sites.length} folders`);

  const agents = await detectAgents();
  const agentLines = Object.entries(agents).map(([key, path]) => `${AGENT_LABELS[key]}: ${path || 'not found'}`);
  row('AI agent CLIs', agentLines.join('  |  '));
  if (Object.values(agents).some(Boolean)) {
    row('  npm global installs', 'land in C:\\nvm4w\\nodejs — switching Node versions can silently lose them');
  }

  if (mysql3306) {
    try {
      const mysqlExe = await resolveMysqlClientExe();
      row('MySQL client', mysqlExe);
      const cred = await resolveRootCredential();
      row('MySQL root credential', cred ? `resolved (${cred.source})` : 'could not resolve — set KATALYST_MYSQL_ROOT_PASSWORD');
    } catch (err) {
      row('MySQL client', `could not resolve — ${err.message}`);
    }
  }

  lines.push('');

  console.log(lines.join('\n'));
}
