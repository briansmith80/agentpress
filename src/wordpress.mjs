// The step the Docker original never needed to write — the `wordpress:latest`
// image did `wp core download` + `wp config create` implicitly via its
// entrypoint. Natively, this module is that entrypoint.
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { runWp, spawnCapture } from './wp.mjs';
import { LARAGON_ROOT } from './paths.mjs';
import { psCapture } from './win.mjs';
import { yellow, WARN } from './ansi.mjs';

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

/**
 * The load-bearing half of the agent-API containment control (the `.htaccess`
 * rewrite below is the other, weaker half).
 *
 * Why a plugin and not just Apache: the rewrite can only match URL SHAPES,
 * and WordPress reaches the identical REST controller through several —
 * `/wp-json/<ns>/...`, `/?rest_route=/<ns>/...`,
 * `/index.php/wp-json/<ns>/...`, and the query-string forms percent-encoded,
 * which Apache does not decode before matching. Confirmed live: a
 * REQUEST_URI-only guard is bypassed by the `?rest_route=` form.
 * `rest_pre_dispatch` sees WP's OWN resolved route instead, which every shape
 * converges on, so this cannot be walked around by re-spelling the URL.
 *
 * TWO namespaces, not one — this is the trap. Blocking only `mcp/` looks
 * complete but is not: WordPress core (7.0+) registers its own Abilities REST
 * API at `wp-abilities/v1`, and every ability in the pack declares
 * `show_in_rest => true`, so `POST /wp-json/wp-abilities/v1/abilities/
 * agent-connector-for-wp/shell-exec/run` reaches shell-exec through core's
 * controller without ever touching an `mcp` route. Verified live on a
 * scaffolded site: that path returns `rest_ability_cannot_execute` (401),
 * i.e. it resolves and reaches the ability, and only auth stands in the way.
 * Both prefixes must be listed. Anything added to the pack's exposure surface
 * later needs adding here too.
 *
 * String.raw: this PHP contains regex backslashes that a normal template
 * literal would eat (`\d` -> `d`), silently widening the address check.
 */
const MCP_GUARD_PHP = String.raw`<?php
/**
 * Plugin Name: AgentPress agent-API loopback guard
 * Description: Rejects non-loopback requests to the MCP and Abilities REST namespaces. Written by create-agentpress; delete it only if you deliberately want remote agent access.
 */

// The Agent Connector's abilities pack grants shell-exec, PHP-eval and
// filesystem write to an authenticated administrator. That capability IS the
// point of an AI-agent dev site, but nothing needs it reachable off this
// machine, and Laragon's Apache binds every interface — so a laptop on a cafe
// network would otherwise expose that chain to anyone holding the application
// password. Agents run locally, so this costs no functionality.
//
// Guarding BOTH namespaces is required, not belt-and-braces: the abilities are
// reachable through core's own wp-abilities/v1 controller as well as through
// the MCP adapter, and blocking only mcp/ leaves shell-exec fully exposed.
//
// REMOTE_ADDR only, never X-Forwarded-For: that header is attacker-supplied
// and there is no trusted reverse proxy in front of a Laragon dev site.

if ( ! function_exists( 'agentpress_is_loopback_remote_addr' ) ) {
	function agentpress_is_loopback_remote_addr( $addr ) {
		$addr = strtolower( trim( (string) $addr ) );
		if ( '' === $addr ) {
			return false;
		}
		if ( '::1' === $addr || '0:0:0:0:0:0:0:1' === $addr ) {
			return true;
		}
		// IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
		if ( 0 === strpos( $addr, '::ffff:' ) ) {
			$addr = substr( $addr, 7 );
		}
		return 1 === preg_match( '/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/', $addr );
	}
}

if ( ! function_exists( 'agentpress_is_guarded_rest_route' ) ) {
	function agentpress_is_guarded_rest_route( $route ) {
		$route = strtolower( ltrim( (string) $route, '/' ) );
		if ( '' === $route ) {
			return false;
		}
		foreach ( array( 'mcp', 'wp-abilities' ) as $ns ) {
			if ( $ns === $route || 0 === strpos( $route, $ns . '/' ) ) {
				return true;
			}
		}
		return false;
	}
}

// PHP_INT_MAX, not 0: every rest_pre_dispatch filter runs and each receives the
// previous one's value, so a plugin registered after us at a higher priority
// could return null and discard our 403. Running LAST means nothing downstream
// can re-allow a request we rejected. (For allowed requests we hand back
// whatever earlier filters produced, untouched.)
add_filter(
	'rest_pre_dispatch',
	function ( $result, $server, $request ) {
		if ( ! is_object( $request ) || ! method_exists( $request, 'get_route' ) ) {
			return $result;
		}
		// WP has already normalised the route by this point, whatever URL shape
		// carried it: "/mcp/mcp-adapter-default-server" either way.
		if ( ! agentpress_is_guarded_rest_route( $request->get_route() ) ) {
			return $result;
		}
		if ( agentpress_is_loopback_remote_addr( isset( $_SERVER['REMOTE_ADDR'] ) ? $_SERVER['REMOTE_ADDR'] : '' ) ) {
			return $result;
		}
		return new WP_Error(
			'agentpress_loopback_only',
			'This site restricts its agent API (MCP and Abilities) to the local machine.',
			array( 'status' => 403 )
		);
	},
	PHP_INT_MAX,
	3
);
`;

export const MCP_GUARD_RELATIVE_PATH = join('wp-content', 'mu-plugins', 'agentpress-mcp-loopback-guard.php');

/**
 * The Apache half, as a marker-delimited block so it can be spliced into an
 * existing `.htaccess` (the backfill path) as well as written fresh.
 *
 * Defence in depth only, and the reason is specific (all verified live against
 * Laragon's Apache): the three conditions cover the URL shapes WordPress
 * accepts — /wp-json/<ns>/…, /index.php/wp-json/<ns>/… and ?rest_route=/<ns>/…
 * — but Apache decodes only the PATH before these run, never the QUERY STRING,
 * so "?rest_route=%2Fmcp%2Fx" never matches here while PHP still hands
 * WordPress a decoded "/mcp/x" and the route resolves. The mu-plugin is what
 * closes that gap. Never rely on this block alone.
 */
const HTACCESS_GUARD_BEGIN = '# BEGIN AgentPress';
const HTACCESS_GUARD_END = '# END AgentPress';

/**
 * The tell that a site still has the Application Password passthrough. Exported
 * because `doctor` greps every site for it and the rewire diagnosis checks the
 * one site it is standing in — both must look for the same string this block
 * writes, or a rename here turns those checks into silent false negatives.
 */
export const HTACCESS_AUTH_MARKER = 'E=HTTP_AUTHORIZATION:';

// Exported so the test suite can pin the two invariants this block must hold:
// it ships the Authorization rule, and it never contains WordPress's own marker
// text (see assertNoWordPressMarker for what happens when it does).
export const HTACCESS_GUARD_BLOCK = `${HTACCESS_GUARD_BEGIN}
# The agent API (MCP + WordPress core's Abilities REST namespace) is
# LOOPBACK-ONLY. The Agent Connector's abilities pack grants shell-exec,
# php-eval and filesystem write to an authenticated admin — that is the point
# of an AI-agent dev site, but nothing needs it reachable off this machine, and
# Laragon's Apache binds every interface (so a laptop on a café network would
# otherwise expose that chain to anyone holding the application password).
# Agents run locally, so this costs no functionality.
#
# DEFENCE IN DEPTH ONLY — the control that actually holds is the mu-plugin at
# wp-content/mu-plugins/agentpress-mcp-loopback-guard.php, which tests WP's own
# resolved REST route rather than URL text. Apache decodes the PATH before
# these conditions run but never the QUERY STRING, so an encoded
# "?rest_route=%2Fmcp%2Fx" slips past this block and is caught only there.
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteCond %{REQUEST_URI} ^/(index\\.php/)?wp-json/(mcp|wp-abilities)(/|$) [NC,OR]
RewriteCond %{QUERY_STRING} (^|&)rest_route=/?(mcp|wp-abilities)(/|&|$) [NC]
RewriteCond %{REMOTE_ADDR} !^(127\\.[0-9.]+|::1|::ffff:127\\.[0-9.]+)$
RewriteRule .* - [F,L]

# Application Password passthrough. Without it, Apache's mod_fcgid (a
# CGI/FastCGI SAPI) strips the Authorization header before PHP ever sees it and
# EVERY application password fails with a bare 401 "rest_forbidden" /
# "rest_not_logged_in" — a well-known gotcha under any CGI/FastCGI PHP SAPI
# (mod_fcgid, PHP-FPM, ...), not specific to Laragon. Re-exposing it as
# HTTP_AUTHORIZATION is what WordPress core's own auth code looks for as a
# fallback when PHP_AUTH_USER isn't set.
#
# It lives in OUR block rather than WordPress's, and the reason is scaffold
# order, not survival. WP-CLI cannot write .htaccess at all (got_mod_rewrite()
# is false off-Apache, see installWordPress), so this hand-written file is the
# ONLY copy of this rule a freshly scaffolded site ever has. Core emits its own
# identical rule as line 3 of its generated block, but not until something
# triggers a hard rewrite flush through a real Apache request, which may be
# never. Keeping our copy in the region we own leaves WordPress's block stock.
RewriteCond %{HTTP:Authorization} ^(.*)
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
</IfModule>
${HTACCESS_GUARD_END}`;

/**
 * Idempotent — overwrites in place, so it is safe to call on every scaffold
 * and on any backfill/harden path. Best-effort by design: a site that cannot
 * take the guard must still finish scaffolding (a half-installed site is
 * worse), but it says so loudly rather than leaving the caller to assume the
 * containment is in place.
 *
 * Writes BOTH layers. The .htaccess half is spliced by marker so an existing
 * file keeps its WordPress block and any hand-written rules; only our own
 * marked region is replaced (the same pattern WordPress uses for its own).
 */
export async function writeMcpLoopbackGuard(publicDir, { onStep, verify = true } = {}) {
  const dest = join(publicDir, MCP_GUARD_RELATIVE_PATH);
  let ok = true;
  try {
    await mkdir(join(publicDir, 'wp-content', 'mu-plugins'), { recursive: true });
    await writeFile(dest, MCP_GUARD_PHP, 'utf8');
  } catch (err) {
    ok = false;
    // Loud, not a step line: this is the control everything else defers to, and
    // the same standard protectProjectSecrets holds itself to.
    console.log(
      `\n${yellow(WARN)} SECURITY: could not write the agent-API loopback guard (${err.message}).\n` +
        "  Without it this site's abilities pack (shell-exec, PHP-eval, filesystem write) is\n" +
        "  reachable from every network this machine joins by anyone holding the site's\n" +
        `  application password. Create ${dest} by hand, or keep this site off untrusted networks.\n`,
    );
  }
  try {
    await spliceHtaccessGuard(join(publicDir, '.htaccess'));
  } catch (err) {
    // Non-fatal: the mu-plugin above is the control that holds, so a failure
    // here loses defence in depth, not the containment itself.
    onStep?.(`(could not update the .htaccess guard block: ${err.message} — the mu-plugin still enforces it)`);
  }
  if (ok && verify) ok = await verifyMcpLoopbackGuard(publicDir, { onStep });
  return ok;
}

/**
 * Written is not loaded. A file on disk proves nothing about whether WordPress
 * actually runs it — a WP_CONTENT_DIR override, a parse error, or mu-plugins
 * being disabled would all leave the containment silently absent while the file
 * sits there looking correct. Asking WordPress itself whether the guard's
 * function exists is the cheapest check that can distinguish those.
 *
 * Three outcomes, deliberately distinguished: loaded (silent), definitely NOT
 * loaded (loud), and could-not-tell (a note). Never fatal — the last thing this
 * should do is fail a scaffold because WP-CLI could not reach the database.
 */
export async function verifyMcpLoopbackGuard(publicDir, { onStep } = {}) {
  const probe = await runWp(['eval', 'echo function_exists("agentpress_is_guarded_rest_route") ? "LOADED" : "MISSING";'], {
    path: publicDir,
  });
  if (probe.code !== 0) {
    onStep?.('(could not confirm the loopback guard is loaded — WP-CLI did not run; the file is in place)');
    return true;
  }
  if (/LOADED/.test(probe.stdout)) return true;
  console.log(
    `\n${yellow(WARN)} SECURITY: the agent-API loopback guard was written but WordPress is not loading it\n` +
      `  (checked with wp eval in ${publicDir}). The abilities pack may be reachable from this\n` +
      "  machine's network. Check that must-use plugins are enabled and that wp-config.php does\n" +
      `  not move WP_CONTENT_DIR away from ${join(publicDir, 'wp-content')}.\n`,
  );
  return false;
}

/**
 * Re-splices the AgentPress block into an existing site's .htaccess and reports
 * whether that changed anything, so `rewire` can repair a site that cannot
 * authenticate before it mints a credential that site would only reject.
 *
 * Cheap and idempotent — spliceHtaccessGuard writes only on a genuine
 * difference — so callers can run it unconditionally rather than trying to
 * decide in advance whether a site needs it.
 */
export async function ensureHtaccessGuardBlock(publicDir) {
  const htaccessPath = join(publicDir, '.htaccess');
  let before = null;
  try {
    before = await readFile(htaccessPath, 'utf8');
  } catch {
    // absent: splice creates it, and "changed" is the honest answer
  }
  await spliceHtaccessGuard(htaccessPath);
  let after = null;
  try {
    after = await readFile(htaccessPath, 'utf8');
  } catch {
    return { changed: false };
  }
  return { changed: before !== after, restoredAuth: before !== null && !before.includes(HTACCESS_AUTH_MARKER) && after.includes(HTACCESS_AUTH_MARKER) };
}

/**
 * Our block must never contain the TEXT of WordPress's own markers, not even
 * inside a comment. Live-verified the hard way while writing v1.7.0: a comment
 * line here reading `above "# BEGIN WordPress"` corrupted the file on the next
 * flush, because core's insert_with_markers() detects its markers with
 * str_contains() on each LINE, not an equality test or an anchored match. It
 * accepted our prose line as the opening marker, treated everything after it as
 * its own block, and replaced the lot — swallowing the real marker and half our
 * comment. Nothing in the code looked wrong; only a real flush showed it.
 *
 * Checked at write time and fails SAFE (leaves the file untouched and says so)
 * rather than asserting at import, because the failure mode being prevented is
 * a corrupted .htaccess on a user's live site.
 */
function assertNoWordPressMarker(block) {
  // Assembled at runtime so this guard does not contain the very string it bans.
  const wpMarker = `# ${'BEGIN'} WordPress`;
  if (block.includes(wpMarker) || block.includes(`# ${'END'} WordPress`)) {
    throw new Error(
      "the AgentPress .htaccess block contains WordPress's own marker text, which would make " +
        'WordPress overwrite part of this file on its next rewrite flush. Rephrase the comment.',
    );
  }
}

/**
 * Replaces our marked block in place, prepends it when absent, and creates the
 * file if there is none.
 *
 * The read failure is narrowed to ENOENT ON PURPOSE. A catch-all here treats
 * "could not read" as "empty file" and then writes just our block over a real
 * .htaccess — during development that is exactly what happened (a missing
 * `readFile` import surfaced as a swallowed ReferenceError and destroyed a test
 * site's WordPress rewrite rules). Anything other than a genuinely absent file
 * must propagate so the caller reports it instead of clobbering.
 */
async function spliceHtaccessGuard(htaccessPath) {
  assertNoWordPressMarker(HTACCESS_GUARD_BLOCK);
  let current = '';
  try {
    current = await readFile(htaccessPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const begin = current.indexOf(HTACCESS_GUARD_BEGIN);
  const end = current.indexOf(HTACCESS_GUARD_END);
  let next;
  if (begin !== -1 && end !== -1 && end > begin) {
    next = current.slice(0, begin) + HTACCESS_GUARD_BLOCK + current.slice(end + HTACCESS_GUARD_END.length);
  } else if (current.trim()) {
    // Prepend: the guard must be evaluated before WordPress's own rewrite
    // hands the request to index.php.
    next = `${HTACCESS_GUARD_BLOCK}\n\n${current}`;
  } else {
    next = `${HTACCESS_GUARD_BLOCK}\n`;
  }
  if (next !== current) await writeFile(htaccessPath, next, 'utf8');
}

/**
 * Why did an application password just get a 401? Answers the question the user
 * is actually standing in front of, instead of the generic "restart your agent
 * session" that used to print here regardless.
 *
 * That generic advice is right for exactly one cause (a session still holding
 * the pre-rewire password) and actively misleading for every other, because the
 * 401 being reported came from THIS process's own loopback probe using a
 * credential minted seconds earlier — no agent session involved.
 *
 * Prompted by a field report where the cause could not be determined from the
 * output AT ALL: the only actionable line on screen told the user to restart
 * their agent, which was irrelevant to every candidate cause. That is the gap
 * this closes — not any one of the causes below, but the silence about which.
 *
 * Best-effort and silent when it finds nothing: returning no hint is better than
 * inventing one, and the caller still prints the raw failure either way.
 */
export async function diagnoseAppPasswordAuth({ publicDir }) {
  const hints = [];

  let htaccess = null;
  try {
    htaccess = await readFile(join(publicDir, '.htaccess'), 'utf8');
  } catch {
    // absent or unreadable — say nothing rather than guess
  }
  if (htaccess !== null && !htaccess.includes(HTACCESS_AUTH_MARKER)) {
    // Note this is a genuinely odd state, worth saying plainly rather than
    // guessing a cause: both AgentPress and WordPress core write this rule, so
    // for it to be absent from BOTH blocks something else has rewritten the
    // file — a security or caching plugin managing its own .htaccess, or a
    // hand-edit. Naming a culprit we have not verified would be worse than
    // naming the symptom and the repair.
    hints.push(
      'public/.htaccess has no Authorization passthrough in it at all, so Apache is\n' +
        '    stripping the credential before PHP sees it and every application password on\n' +
        '    this site will 401. Something other than AgentPress or WordPress core has\n' +
        '    rewritten this file.\n' +
        '    Fix: run `rewire` again to restore the block, then find what rewrote it.',
    );
  }

  // Under WP-CLI is_ssl() is false, so wp_is_application_passwords_supported()
  // reduces to the environment-type test — which is precisely the thing worth
  // measuring, since MCP talks plain http. The _available() wrapper also runs
  // the filter, so a security plugin switching app passwords off shows up here
  // as available=0 with a perfectly normal environment type.
  const probe = await runWp(['eval', 'echo wp_get_environment_type() . "|" . ( wp_is_application_passwords_available() ? "1" : "0" );'], {
    path: publicDir,
  });
  if (probe.code === 0) {
    const [envType, available] = probe.stdout.trim().split('|');
    if (envType && envType !== 'local') {
      hints.push(
        `public/wp-config.php is missing define('WP_ENVIRONMENT_TYPE', 'local') — it\n` +
          `    reports "${envType}". WordPress refuses application passwords over plain http\n` +
          '    unless the environment is local, and MCP talks http.\n' +
          "    Fix: add define('WP_ENVIRONMENT_TYPE', 'local'); to public/wp-config.php.",
      );
    } else if (available === '0') {
      hints.push(
        'WordPress reports application passwords as unavailable on this site even though\n' +
          '    the environment is local, so a plugin is filtering them off\n' +
          '    (wp_is_application_passwords_available).\n' +
          '    Fix: find and deactivate that plugin — usually a security or hardening one.',
      );
    }
  }

  return hints;
}

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
  // One definition of the guard block, shared with the backfill path — a
  // second inline copy here is how the two drift apart.
  //
  // The WordPress block below is STOCK, deliberately. Up to v1.6.0 it also
  // carried an Authorization passthrough; that now lives in the AgentPress
  // block instead. Two reasons, both checked against core rather than assumed:
  // WordPress owns everything between its own markers and rewrites it wholesale
  // on any hard flush, and core's generated rules already include an identical
  // passthrough (class-wp-rewrite.php, mod_rewrite_rules()), so a copy placed
  // here was both at risk and redundant. Do not add directives to this block.
  await writeFile(
    join(publicDir, '.htaccess'),
    `${HTACCESS_GUARD_BLOCK}

# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
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

  onStep?.('installing the MCP loopback guard…');
  await writeMcpLoopbackGuard(publicDir, { onStep });

  return { url: `${scheme}://${hostname}`, adminUrl: `${scheme}://${hostname}/wp-admin` };
}
