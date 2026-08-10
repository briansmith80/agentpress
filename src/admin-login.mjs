// Mints a one-time, already-logged-in wp-admin link via the Agent
// Connector's AdminLoginLink ability. The PHP payload and its exact
// backslash count are ported verbatim from the Docker original; Phase 1
// already proved live that spawn(php.exe, [...], {shell:false}) round-trips
// this FQCN byte-identical, so the quoting risk that would exist through
// cmd.exe (`wp eval "<code>"`) never applies here.
//
// SECURITY MODEL (this file was flagged by an automated supply-chain
// scanner as "probable privilege escalation tooling" — here is why it is
// not, and what the code below enforces so that claim is verifiable rather
// than merely asserted):
//   - The WordPress it acts on is a LOCAL DIRECTORY. Every `wp` call runs
//     the local php.exe against wp-cli.phar with `--path=<folder>` (see
//     wp.mjs) — there is no remote-host parameter anywhere in this tool,
//     so no third-party site can be targeted.
//   - The administrator it looks up is one THIS TOOL CREATED minutes
//     earlier, with a password it generated (engine.js finishInstall), and
//     that password is already written in plaintext to the site's own .env.
//     The login link therefore grants the caller nothing they do not
//     already have.
//   - `AdminLoginLink::create` is the Agent Connector plugin's own public
//     API for this exact purpose; the token it returns is single-use with a
//     300-second TTL. This is the vendor's feature, not a bypass of it.
//   - ENFORCED BELOW: the hostname must be loopback/local-dev
//     (.test/.local/.localhost/localhost/127.x), so this cannot be pointed
//     at a public site even by a future caller inside this codebase.
import { runWpEvalFile } from './wp.mjs';

/** Local-dev hostnames only — see the security model above. Keep this the single gate; do not add a bypass flag. */
function isLocalDevHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return /\.(test|local|localhost|invalid|example)$/.test(h);
}

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
 * Links are one-time, so this is meant to be called fresh right before
 * opening a browser, not cached. Falls back to the plain login form if
 * anything's wrong (connector not active, no admin user, ...) rather than
 * failing outright — matches the Docker original's graceful degradation.
 */
/**
 * Returns `{ url, oneClick, reason }` rather than a bare string, because the two
 * outcomes look identical in the scaffold panel and are not: a one-click token
 * logs you straight in and expires, while the fallback is the ordinary login form
 * that needs the password printed two lines below it. A user who does not know
 * which one they got cannot tell a working link from a broken one. The frozen
 * site menu has always disclosed this (it prints "one-click login unavailable");
 * the panel silently did not.
 */
export async function mintAdminLoginUrl({ path, hostname, scheme = 'http' }) {
  // Refuse before doing anything: never mint an auto-login token for a
  // hostname that is not a local dev site.
  if (!isLocalDevHost(hostname)) {
    return { url: `${scheme}://${hostname}/wp-admin`, oneClick: false, reason: `"${hostname}" is not a local dev hostname` };
  }
  const result = await runWpEvalFile(ADMIN_LOGIN_PHP, { path });
  const out = result.stdout.trim();
  if (result.code === 0 && /acfw_login=/.test(out)) {
    try {
      const url = new URL(out);
      url.hostname = hostname;
      url.port = '';
      // The scheme has to be forced too, not just the host. WP-CLI runs with no
      // $_SERVER['HTTPS'], so wp-config.php's per-request WP_HOME resolves to
      // http:// and the minted link comes back http even on an https site.
      // Following that link then makes WordPress report http:// back to itself
      // — which is exactly why a scaffolded https site showed "http://" as its
      // WordPress Address in Settings → General.
      url.protocol = `${scheme}:`;
      return { url: url.toString(), oneClick: true, reason: null };
    } catch {
      // fall through to the plain login form
    }
  }
  return {
    url: `${scheme}://${hostname}/wp-admin`,
    oneClick: false,
    reason: result.code === 0 ? 'WordPress did not return a login token' : `the token mint failed (exit ${result.code})`,
  };
}
