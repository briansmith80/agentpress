// Shared path constants.
//
// LARAGON_ROOT resolution order (first hit wins):
//   1. AGENTPRESS_LARAGON_ROOT env var (legacy KATALYST_LARAGON_ROOT honored)
//   2. C:\laragon when laragon.exe exists there — the default install; fast
//      path, costs one existsSync
//   3. the running laragon.exe process's own directory — covers D:\laragon
//      installs at the cost of one synchronous PowerShell query, paid only
//      when the default location is empty
//   4. C:\laragon regardless — so doctor/preflight can REPORT it missing
//      instead of this module throwing at import time
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Absolute path, not bare 'powershell.exe' — a PATH mangled by an installer
// or npm script would otherwise break/subvert every OS probe at once.
export const PS_EXE = (() => {
  const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(sys) ? sys : 'powershell.exe';
})();

function resolveLaragonRoot() {
  const override = process.env.AGENTPRESS_LARAGON_ROOT ?? process.env.KATALYST_LARAGON_ROOT;
  if (override) return override.replace(/[\\/]+$/, '');
  if (existsSync('C:\\laragon\\laragon.exe')) return 'C:\\laragon';
  const probe = spawnSync(
    PS_EXE,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='laragon.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath)",
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  const exe = (probe.stdout || '').trim();
  if (exe) return dirname(exe);
  return 'C:\\laragon';
}

export const LARAGON_ROOT = resolveLaragonRoot();
export const LARAGON_EXE = join(LARAGON_ROOT, 'laragon.exe');
export const LARAGON_INI = join(LARAGON_ROOT, 'usr', 'laragon.ini');
export const WWW_DIR = join(LARAGON_ROOT, 'www');
export const SITES_ENABLED_APACHE = join(LARAGON_ROOT, 'etc', 'apache2', 'sites-enabled');
export const SITES_ENABLED_NGINX = join(LARAGON_ROOT, 'etc', 'nginx', 'sites-enabled');
export const HOSTS_PATH = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');

/**
 * The tool was renamed from create-katalyst-laragon to create-agentpress —
 * a machine that ran the old version has its license key, premium plugin
 * zips, registry, and caches under ~/.katalyst-laragon. Move the whole tree
 * once; if the rename fails (open handle), fall back to using the legacy
 * dir in place so nothing is lost.
 */
function resolveHome() {
  const home = join(homedir(), '.agentpress');
  const legacy = join(homedir(), '.katalyst-laragon');
  if (!existsSync(home) && existsSync(legacy)) {
    try {
      renameSync(legacy, home);
    } catch {
      return legacy;
    }
  }
  return home;
}

export const AGENTPRESS_HOME = resolveHome();
export const CONFIG_PATH = join(AGENTPRESS_HOME, 'config.json');
export const WP_CLI_CACHE_DIR = join(AGENTPRESS_HOME, 'cache');
export const BACKUPS_DIR = join(AGENTPRESS_HOME, 'backups');
export const SCAFFOLD_LOCK_PATH = join(AGENTPRESS_HOME, 'scaffold.lock');
export const REGISTRY_PATH = join(AGENTPRESS_HOME, 'environments.json');
export const PREMIUM_PLUGINS_DIR = join(AGENTPRESS_HOME, 'premium-plugins');
export const STAGING_DIR = join(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'agentpress',
  'staging',
);
