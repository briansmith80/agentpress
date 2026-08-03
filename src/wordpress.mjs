// The step the Docker original never needed to write — the `wordpress:latest`
// image did `wp core download` + `wp config create` implicitly via its
// entrypoint. Natively, this module is that entrypoint.
import { rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { runWp, spawnCapture } from './wp.mjs';
import { LARAGON_ROOT } from './paths.mjs';
import { psCapture } from './win.mjs';

const WP_DOWNLOAD_URL = 'https://wordpress.org/latest.tar.gz';

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

let cachedTarExe = null;

async function resolveTarExe() {
  if (cachedTarExe) return cachedTarExe;
  const candidates = [
    'C:\\Windows\\System32\\tar.exe', // built in since Windows 10 1803
    join(LARAGON_ROOT, 'bin', 'git', 'usr', 'bin', 'tar.exe'),
  ];
  for (const c of candidates) {
    if (await exists(c)) {
      cachedTarExe = c;
      return c;
    }
  }
  const { stdout } = await psCapture('(Get-Command tar -ErrorAction SilentlyContinue).Source');
  if (stdout.trim()) {
    cachedTarExe = stdout.trim();
    return cachedTarExe;
  }
  throw new Error('No tar.exe found (checked System32, Laragon\'s bundled Git, and PATH).');
}

/**
 * `wp core download` is bypassed entirely — confirmed live: PHP's PharData
 * fails extracting WordPress 7.0.2's core (a path 103 chars deep, just past
 * the classic 100-char USTAR filename-field boundary — a known PHP/Windows
 * PharData bug), and WP-CLI's own `tar` fallback then fails too, unable to
 * locate `tar.exe` despite it being on PATH (confirmed present at
 * `C:\Windows\System32\tar.exe`). Downloading and extracting ourselves with
 * a directly-resolved tar.exe sidesteps both bugs at once.
 */
async function downloadAndExtractCore(publicDir) {
  const tmpFile = join(tmpdir(), `agentpress-wp-core-${randomBytes(6).toString('hex')}.tar.gz`);
  const res = await fetch(WP_DOWNLOAD_URL);
  if (!res.ok) throw new Error(`Failed to download WordPress core: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  // Bypassing `wp core download` (see above) also bypassed the checksum IT
  // verifies, so this restores it: wordpress.org publishes a .sha1 sidecar for
  // the tarball. Be clear about the strength — a digest fetched from the same
  // origin over the same TLS chain proves the tarball was not corrupted or
  // swapped in transit/at a CDN edge, but NOT that wordpress.org itself is
  // honest (it could serve a matching bad pair). A pinned constant would be
  // stronger, but WordPress core must track latest for a dev tool, so this is
  // the strongest check available without freezing the version.
  const sha1 = await fetch(`${WP_DOWNLOAD_URL}.sha1`)
    .then((r) => (r.ok ? r.text() : null))
    .then((t) => (t ? t.trim().split(/\s+/)[0].toLowerCase() : null))
    .catch(() => null);
  if (sha1 && /^[a-f0-9]{40}$/.test(sha1)) {
    const actual = createHash('sha1').update(bytes).digest('hex');
    if (actual !== sha1) {
      throw new Error(
        `WordPress core failed its published SHA-1 check — nothing was extracted.\n` +
          `  expected ${sha1}\n  actual   ${actual}`,
      );
    }
  } else {
    console.log('  (could not fetch the published WordPress checksum — continuing without that check)');
  }

  await writeFile(tmpFile, bytes);
  try {
    const tarExe = await resolveTarExe();
    const result = await spawnCapture(tarExe, ['xzf', tmpFile, '-C', publicDir, '--strip-components=1']);
    if (result.code !== 0) {
      throw new Error(`tar extraction failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
    }
  } finally {
    await rm(tmpFile, { force: true }).catch(() => {});
  }
}

// mod_fcgid ignores php_value in .htaccess (500 error) — .user.ini is the
// per-site lever that doesn't touch the php.ini shared by every other
// Laragon site. Effective upload cap on this machine is 8M from
// post_max_size, not the 50M upload_max_filesize alone would suggest.
const USER_INI = `post_max_size = 128M
upload_max_filesize = 128M
memory_limit = 512M
max_execution_time = 300
`;

// Dynamic WP_HOME/WP_SITEURL (derived from the request's Host header) so the
// site works regardless of exactly how it's reached, same approach as the
// Docker original. FS_METHOD=direct avoids the FTP-credentials prompt WP
// otherwise shows when its uid-vs-owner heuristic can't confirm direct
// filesystem access. WP_ENVIRONMENT_TYPE=local is REQUIRED for Application
// Passwords over plain HTTP (WP_Application_Passwords checks
// wp_is_local_environment()) — Phase 7's MCP wiring depends on it.
const EXTRA_PHP = `define('WP_ENVIRONMENT_TYPE', 'local');
define('FS_METHOD', 'direct');
if ( ! empty( $_SERVER['HTTP_HOST'] ) ) {
    $scheme = ( ! empty( $_SERVER['HTTPS'] ) && $_SERVER['HTTPS'] !== 'off' ) ? 'https' : 'http';
    define( 'WP_HOME', $scheme . '://' . $_SERVER['HTTP_HOST'] );
    define( 'WP_SITEURL', $scheme . '://' . $_SERVER['HTTP_HOST'] );
}
`;

function fail(step, result) {
  throw new Error(`${step} failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim()}`);
}

/**
 * `dbName`/`dbUser` are ours-generated identifiers (safe on argv). `dbPassword`
 * necessarily goes on argv too — `wp config create` has no stdin/env
 * alternative for it, unlike the MySQL root credential (which we do protect
 * via MYSQL_PWD). Acceptable: a single-user local dev machine, freshly
 * generated low-privilege per-site credential, momentary exposure.
 */
export async function installWordPress({
  projectDir,
  hostname,
  scheme = 'http',
  dbName,
  dbUser,
  dbPassword,
  dbHost,
  adminUser,
  adminPassword,
  adminEmail,
  siteTitle,
  onStep,
}) {
  const publicDir = join(projectDir, 'public');

  onStep?.('downloading WordPress core…');
  await downloadAndExtractCore(publicDir);

  onStep?.('writing wp-config.php…');
  // --force matters for `resume`: a scaffold that died between config create
  // and the .env write leaves a wp-config.php that, without --force, makes
  // every resume attempt hard-fail forever ("already exists"). Overwriting
  // with the freshly provisioned credentials is correct for both first run
  // and resume.
  let result = await runWp(
    [
      'config',
      'create',
      `--dbname=${dbName}`,
      `--dbuser=${dbUser}`,
      `--dbpass=${dbPassword}`,
      `--dbhost=${dbHost}`,
      '--force',
      '--extra-php',
    ],
    { path: publicDir, input: EXTRA_PHP },
  );
  if (result.code !== 0) fail('wp config create', result);

  onStep?.('installing WordPress…');
  result = await runWp(
    [
      'core',
      'install',
      `--url=${scheme}://${hostname}`,
      `--title=${siteTitle}`,
      `--admin_user=${adminUser}`,
      `--admin_password=${adminPassword}`,
      `--admin_email=${adminEmail}`,
      '--skip-email',
    ],
    { path: publicDir },
  );
  if (result.code !== 0) fail('wp core install', result);

  onStep?.('setting up permalinks…');
  result = await runWp(['rewrite', 'structure', '/%postname%/'], { path: publicDir });
  if (result.code !== 0) fail('wp rewrite structure', result);
  // `wp rewrite flush --hard` alone does NOT write .htaccess here — confirmed
  // live: it reports success but stderr warns "Regenerating a .htaccess file
  // requires special configuration," because WP-CLI runs as a plain CLI
  // process, never inside an actual Apache request, so WordPress's
  // got_mod_rewrite() can't detect Apache and refuses to write it. This is
  // NOT a container-vs-native difference (the Docker original hit the exact
  // same thing for the exact same reason) — being native doesn't change it.
  // Write the standard WordPress ruleset ourselves, same as the original.
  result = await runWp(['rewrite', 'flush', '--hard'], { path: publicDir });
  if (result.code !== 0) fail('wp rewrite flush', result);
  await writeFile(
    join(publicDir, '.htaccess'),
    `# BEGIN AgentPress
# The MCP route is LOOPBACK-ONLY. The Agent Connector's abilities pack grants
# shell-exec, php-eval and filesystem write to an authenticated admin — that
# is the point of an AI-agent dev site, but nothing needs it reachable off
# this machine, and Laragon's Apache binds every interface (so a laptop on a
# café network would otherwise expose that chain to anyone holding the
# application password). Agents run locally, so this costs no functionality.
# Remove these three lines only if you deliberately want remote agent access.
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteCond %{REQUEST_URI} ^/wp-json/mcp/ [NC]
RewriteCond %{REMOTE_ADDR} !^(127\\.[0-9.]+|::1)$
RewriteRule .* - [F,L]
</IfModule>
# END AgentPress

# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
# Confirmed live: without this, Application Passwords fail outright with a
# bare 401 "rest_forbidden"/"rest_not_logged_in" — Apache's mod_fcgid (a
# CGI/FastCGI SAPI) strips the Authorization header before PHP ever sees it,
# a well-known gotcha for WP Application Passwords under any CGI/FastCGI
# PHP SAPI (mod_fcgid, PHP-FPM, ...), not specific to Laragon. Re-exposing
# it as HTTP_AUTHORIZATION is what WordPress core's own auth code looks for
# as a fallback when PHP_AUTH_USER isn't set.
RewriteCond %{HTTP:Authorization} ^(.*)
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
`,
    'utf8',
  );

  await writeFile(join(publicDir, '.user.ini'), USER_INI, 'utf8');

  return { url: `${scheme}://${hostname}`, adminUrl: `${scheme}://${hostname}/wp-admin` };
}
