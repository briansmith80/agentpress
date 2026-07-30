// Shared path constants. %laragon_root% is NOT set as a persistent env var on
// this machine (only inside Laragon's own Terminal) — hardcode the root.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LARAGON_ROOT = 'C:\\laragon';
export const LARAGON_EXE = join(LARAGON_ROOT, 'laragon.exe');
export const LARAGON_INI = join(LARAGON_ROOT, 'usr', 'laragon.ini');
export const WWW_DIR = join(LARAGON_ROOT, 'www');
export const SITES_ENABLED_APACHE = join(LARAGON_ROOT, 'etc', 'apache2', 'sites-enabled');
export const SITES_ENABLED_NGINX = join(LARAGON_ROOT, 'etc', 'nginx', 'sites-enabled');
export const HOSTS_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts';

export const KATALYST_HOME = join(homedir(), '.katalyst-laragon');
export const WP_CLI_CACHE_DIR = join(KATALYST_HOME, 'cache');
export const BACKUPS_DIR = join(KATALYST_HOME, 'backups');
export const SCAFFOLD_LOCK_PATH = join(KATALYST_HOME, 'scaffold.lock');
export const REGISTRY_PATH = join(KATALYST_HOME, 'environments.json');
export const STAGING_DIR = join(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'katalyst-laragon',
  'staging',
);
