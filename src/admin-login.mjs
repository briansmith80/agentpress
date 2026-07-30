// Mints a one-time, already-logged-in wp-admin link via the Agent
// Connector's AdminLoginLink ability. The PHP payload and its exact
// backslash count are ported verbatim from the Docker original; Phase 1
// already proved live that spawn(php.exe, [...], {shell:false}) round-trips
// this FQCN byte-identical, so the quoting risk that would exist through
// cmd.exe (`wp eval "<code>"`) never applies here.
import { runWpEvalFile } from './wp.mjs';

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
export async function mintAdminLoginUrl({ path, hostname }) {
  const result = await runWpEvalFile(ADMIN_LOGIN_PHP, { path });
  const out = result.stdout.trim();
  if (result.code === 0 && /acfw_login=/.test(out)) {
    try {
      const url = new URL(out);
      url.hostname = hostname;
      url.port = '';
      return url.toString();
    } catch {
      // fall through to the plain login form
    }
  }
  return `http://${hostname}/wp-admin`;
}
