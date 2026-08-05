// Per-site MySQL database + user provisioning.
//
// Key decisions, each grounded in something verified about this machine:
//   - Resolve mysql.exe from the ACTUALLY-RUNNING mysqld.exe's own directory,
//     not whatever "mysql" happens to resolve to on PATH — same reasoning as
//     resolvePhpExe in wp.mjs (PATH and "what's actually serving" have
//     already been shown to diverge for PHP on this machine).
//   - The ROOT password never goes on argv (`-p<pw>` lands in the process
//     list, and in any log that tees stdout/stderr wholesale) — always
//     MYSQL_PWD. Note the scope: a per-site password being CREATED does reach
//     argv inside the `-e` statement, unavoidably, and the same secret already
//     reaches argv via `wp config create --dbpass` (see wordpress.mjs) — so
//     this invariant is about the root credential, not about every secret.
//   - No explicit auth plugin in CREATE USER. my.ini sets
//     default_authentication_plugin=mysql_native_password, but laragon.log
//     shows repeated "Plugin 'mysql_native_password' is not loaded" — naming
//     it explicitly would hard-fail. Let the server pick.
//   - Connections always target 127.0.0.1, never "localhost" — my.ini's
//     socket path is meaningless on Windows, and "localhost" can resolve to
//     ::1 or take a named-pipe path.
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { LARAGON_ROOT } from './paths.mjs';
import { psCapture } from './win.mjs';
import { compareVersionsDesc, spawnCapture } from './wp.mjs';
import { generatePassword } from './secrets.mjs';

const MYSQL_BASE = join(LARAGON_ROOT, 'bin', 'mysql');

/** Laragon defaults to 3306, but users with a system MySQL commonly move it (3307/3308) — overridable rather than dead-ending them. */
export const MYSQL_PORT = Number(process.env.AGENTPRESS_MYSQL_PORT ?? process.env.KATALYST_MYSQL_PORT) || 3306;

// Laragon offers MariaDB as a drop-in under bin\mysql\; MariaDB 11+ runs as
// mariadbd.exe with mariadb.exe as the client (the mysql.exe shim is
// deprecated upstream). The SQL this module emits is already MariaDB-safe —
// only the process/exe names need to know both spellings.
const CLIENT_EXE_NAMES = ['mysql.exe', 'mariadb.exe'];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveMysqldExe() {
  const { code, stdout } = await psCapture(
    "(Get-CimInstance Win32_Process -Filter \"Name='mysqld.exe' OR Name='mariadbd.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath)",
  );
  if (code !== 0) return null;
  return stdout.trim() || null;
}

let cachedMysqlClientExe = null;

export async function resolveMysqlClientExe() {
  if (cachedMysqlClientExe) return cachedMysqlClientExe;
  const mysqldExe = await resolveMysqldExe();
  if (mysqldExe) {
    for (const name of CLIENT_EXE_NAMES) {
      const clientExe = join(dirname(mysqldExe), name);
      if (await exists(clientExe)) {
        cachedMysqlClientExe = clientExe;
        return clientExe;
      }
    }
  }
  // The daemon isn't running (or its dir has no client) — fall back to the
  // highest-version client under bin/mysql/*/bin on disk.
  let dirs;
  try {
    dirs = (await readdir(MYSQL_BASE)).sort(compareVersionsDesc);
  } catch {
    throw new Error(`No MySQL installation found under ${MYSQL_BASE}`);
  }
  for (const d of dirs) {
    for (const name of CLIENT_EXE_NAMES) {
      const exe = join(MYSQL_BASE, d, 'bin', name);
      if (await exists(exe)) {
        cachedMysqlClientExe = exe;
        return exe;
      }
    }
  }
  throw new Error(`No mysql.exe/mariadb.exe found under ${MYSQL_BASE}`);
}

export function escapeSqlString(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Never puts the password on argv — spawn() with shell:false, password via MYSQL_PWD env. */
export async function runMysql(sql, { user, password, database, host = '127.0.0.1', port = MYSQL_PORT } = {}) {
  const exe = await resolveMysqlClientExe();
  const args = ['--protocol=TCP', '-h', host, '-P', String(port), '-u', user, '-N', '-B'];
  if (database) args.push('-D', database);
  args.push('-e', sql);
  return spawnCapture(exe, args, { env: { ...process.env, MYSQL_PWD: password ?? '' } });
}

/**
 * Ladder: an explicit override env var, then the two conventional local
 * defaults. Deliberately does NOT persist whatever's found — the plan
 * favors not caching root at all over a half-baked encrypted-storage story.
 * `host`/`port` matter for destroy: the site records where it was
 * provisioned in .env's DB_HOST, and probing the CURRENT process's default
 * port instead could resolve credentials against a different server.
 */
export async function resolveRootCredential({ host = '127.0.0.1', port = MYSQL_PORT } = {}) {
  const candidates = [
    (process.env.AGENTPRESS_MYSQL_ROOT_PASSWORD ?? process.env.KATALYST_MYSQL_ROOT_PASSWORD) !== undefined
      ? { password: process.env.AGENTPRESS_MYSQL_ROOT_PASSWORD ?? process.env.KATALYST_MYSQL_ROOT_PASSWORD, source: 'AGENTPRESS_MYSQL_ROOT_PASSWORD env var' }
      : null,
    { password: '', source: 'empty password' },
    { password: 'root', source: 'password "root"' },
  ].filter(Boolean);
  for (const c of candidates) {
    const result = await runMysql('SELECT 1;', { user: 'root', password: c.password, host, port });
    if (result.code === 0) return c;
  }
  return null;
}

/** Splits an .env DB_HOST ("127.0.0.1" or "127.0.0.1:3307") back into connection opts. */
export function parseDbHost(dbHost) {
  if (!dbHost) return { host: '127.0.0.1', port: MYSQL_PORT };
  const m = String(dbHost).match(/^(.*?)(?::(\d+))?$/);
  return { host: m[1] || '127.0.0.1', port: m[2] ? Number(m[2]) : MYSQL_PORT };
}

/** DB names: max 64 chars. User names: max 32. Truncate + short content hash rather than blindly chopping, so two names that only differ after the cutoff don't collide. */
export function sanitizeDbIdentifier(name, maxLength) {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (cleaned.length <= maxLength) return cleaned;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 6);
  return `${cleaned.slice(0, maxLength - 7)}_${hash}`;
}

async function databaseExists(name, cred) {
  const result = await runMysql(`SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${escapeSqlString(name)}';`, {
    user: 'root',
    password: cred.password,
  });
  return result.code === 0 && result.stdout.trim().length > 0;
}

/** MySQL on Windows is case-insensitive (lower_case_table_names=1 by default) — "my-site" and "my_site" both sanitize to "my_site" and must be treated as the same name for uniqueness purposes. */
export async function uniqueDbName(baseName, cred) {
  let candidate = sanitizeDbIdentifier(baseName, 64);
  let n = 2;
  while (await databaseExists(candidate, cred)) {
    candidate = sanitizeDbIdentifier(`${baseName}_${n}`, 64);
    n += 1;
  }
  return candidate;
}

/**
 * Creates a dedicated DB + user (never reuses root in .env). The '127.0.0.1'
 * host is exact-string matched by MySQL's grant tables — since every
 * connection this tool makes targets 127.0.0.1 (never "localhost"), only
 * that host needs a grant.
 */
export async function provisionDatabase(siteName, cred) {
  const dbName = await uniqueDbName(siteName, cred);
  const dbUser = sanitizeDbIdentifier(dbName, 32);
  const dbPassword = generatePassword('db');
  const sql = [
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    `CREATE USER IF NOT EXISTS '${dbUser}'@'127.0.0.1' IDENTIFIED BY '${escapeSqlString(dbPassword)}';`,
    // CREATE USER IF NOT EXISTS keeps a PRE-EXISTING user's old password while
    // the freshly generated one goes into wp-config.php. uniqueDbName only
    // guarantees the DATABASE is new, and dbUser is derived from it, so the
    // realistic half-cleanup — database dropped by hand in phpMyAdmin, user
    // left behind — reuses that user name and hands WordPress a password the
    // server doesn't have. The symptom is WP's generic "Error establishing a
    // database connection", pointing nowhere near the cause. ALTER makes the
    // password deterministic (MySQL 5.7.6+ / MariaDB 10.2+).
    `ALTER USER '${dbUser}'@'127.0.0.1' IDENTIFIED BY '${escapeSqlString(dbPassword)}';`,
    `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'127.0.0.1';`,
    'FLUSH PRIVILEGES;',
  ].join('\n');
  const result = await runMysql(sql, { user: 'root', password: cred.password });
  if (result.code !== 0) {
    throw new Error(`Failed to provision database: ${result.stderr || result.stdout}`);
  }
  // host:port form — `wp config create --dbhost` accepts it, and it keeps
  // the non-default-port case working end to end without a separate DB_PORT.
  return { dbName, dbUser, dbPassword, dbHost: MYSQL_PORT === 3306 ? '127.0.0.1' : `127.0.0.1:${MYSQL_PORT}` };
}

/** DB_NAME/DB_USER arrive from a site's .env, which can be hand-edited or arrive with someone else's project — validate before interpolating into root-privileged SQL. Our own names are always [a-z0-9_]. */
function assertSafeIdentifier(value, label) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(String(value || ''))) {
    throw new Error(`Refusing to use "${value}" as a MySQL ${label}: expected letters, digits and underscores only.`);
  }
}

export async function dropDatabase(dbName, dbUser, cred, { host = '127.0.0.1', port = MYSQL_PORT } = {}) {
  assertSafeIdentifier(dbName, 'database name');
  assertSafeIdentifier(dbUser, 'user name');
  const sql = [`DROP DATABASE IF EXISTS \`${dbName}\`;`, `DROP USER IF EXISTS '${dbUser}'@'127.0.0.1';`].join('\n');
  return runMysql(sql, { user: 'root', password: cred.password, host, port });
}
