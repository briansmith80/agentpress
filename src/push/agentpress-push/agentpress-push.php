<?php
/**
 * Plugin Name: AgentPress Push
 * Description: Receives a site pushed from a local AgentPress install, and hands this site's content back for a pull. Driven by `agentpress push` / `agentpress pull`; does nothing until a connection key is created under Tools > AgentPress Push.
 * Version: 0.1.11
 * Author: AgentPress
 * License: GPL-2.0-or-later
 * Requires PHP: 7.4
 */

// One file on purpose. It is copied to a live shared host by hand (zip upload
// or File Manager), with no SSH and no composer, so "the plugin" has to be a
// thing a person can see is complete. The local side runs the very same file
// through WP-CLI, so an export made on one end is always in the dialect the
// other end's import reads.
//
// The split that keeps both ends safe:
//   design (Oxygen templates, blocks, selectors) is owned by LOCAL, goes UP
//   content (stories, media, users, comments)    is owned by LIVE,  comes DOWN
// A whole-database copy is only ever the first copy up, or a pull down.
//
// Every long job is cut into steps that each stop after a few seconds and
// hand back a `state` to resume from. Shared hosts kill a PHP request at
// 30s, and a job that only works when the site is small is the job that
// fails the day it matters.

if (!defined('ABSPATH')) {
    exit;
}

const AGENTPRESS_PUSH_VERSION = '0.1.11';
const AGENTPRESS_PUSH_FORMAT = 1;
const AGENTPRESS_PUSH_STEP_SECONDS = 8;
const AGENTPRESS_PUSH_UID = '_agentpress_uid';
// Stories (see the Stories section). SENT is the dev site's note on a story:
// `live` when the live site has it as its own, a fingerprint when this tool
// sent it. LIVE is the receiving site's note of what arrived, UNDONE marks a
// story an undo of ours put in the bin. SYNCED names the live site those
// notes were taken against; it is an option, so it must stay with its own
// site through a copy (LOCAL_STORY_OPTIONS in push.mjs).
const AGENTPRESS_PUSH_STORY_SENT = '_agentpress_story_sent';
const AGENTPRESS_PUSH_STORY_LIVE = '_agentpress_story_live';
const AGENTPRESS_PUSH_STORY_UNDONE = '_agentpress_story_undone';
const AGENTPRESS_PUSH_STORIES_SYNCED = 'agentpress_push_stories_synced';
const AGENTPRESS_PUSH_NEW = 'apnew_';
const AGENTPRESS_PUSH_OLD = 'apold_';
const AGENTPRESS_PUSH_TMP = 'aptmp_';

/* ------------------------------------------------------------------------
 * Storage: wp-content/agentpress-push-data
 * --------------------------------------------------------------------- */

/**
 * The key lives in a FILE here, not in the database, because a full copy
 * replaces the database underneath a running push. A key kept in wp_options
 * would vanish at the table swap and every later step would 401 with the job
 * half done.
 */
function agentpress_push_data_dir()
{
    $dir = WP_CONTENT_DIR . '/agentpress-push-data';
    if (!is_dir($dir)) {
        wp_mkdir_p($dir);
    }
    if (!file_exists($dir . '/index.php')) {
        @file_put_contents($dir . '/index.php', "<?php\n// Silence is golden.\n");
    }
    if (!file_exists($dir . '/.htaccess')) {
        // Apache and LiteSpeed honour this. nginx does not, which is why
        // nothing readable is ever stored under a guessable name: sessions are
        // 128-bit random, and the key file is PHP that prints nothing.
        @file_put_contents($dir . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
    }
    return $dir;
}

function agentpress_push_fail($code, $message, $status = 400)
{
    return new WP_Error('agentpress_push_' . $code, $message, ['status' => $status]);
}

function agentpress_push_session_dir($session, $create = false)
{
    if (!is_string($session) || !preg_match('/^[a-f0-9]{32}$/', $session)) {
        return agentpress_push_fail('bad_session', 'Missing or malformed session id.');
    }
    $dir = agentpress_push_data_dir() . '/s-' . $session;
    if (!is_dir($dir)) {
        if (!$create) {
            return agentpress_push_fail('no_session', 'That session does not exist on this site (it may have been cleaned up).', 404);
        }
        wp_mkdir_p($dir);
    }
    return $dir;
}

/** Files a client may put into, or get out of, a session. Nothing else. */
function agentpress_push_session_files()
{
    return ['db.ndjson', 'files.pack', 'want.ndjson', 'manifest.ndjson', 'design.json', 'stories.json'];
}

function agentpress_push_rrmdir($dir)
{
    if (!is_dir($dir)) {
        return;
    }
    foreach (scandir($dir) as $entry) {
        if ($entry === '.' || $entry === '..') {
            continue;
        }
        $path = $dir . '/' . $entry;
        is_dir($path) && !is_link($path) ? agentpress_push_rrmdir($path) : @unlink($path);
    }
    @rmdir($dir);
}

/* ------------------------------------------------------------------------
 * The connection key
 * --------------------------------------------------------------------- */

function agentpress_push_key_file()
{
    return agentpress_push_data_dir() . '/key.php';
}

function agentpress_push_key_record()
{
    $file = agentpress_push_key_file();
    if (!is_file($file)) {
        return null;
    }
    $record = include $file;
    return is_array($record) && !empty($record['hash']) ? $record : null;
}

/** Makes a new key, stores only its hash, returns the key ONCE. */
function agentpress_push_key_create()
{
    $key = bin2hex(random_bytes(24));
    $record = ['hash' => hash('sha256', $key), 'created' => time()];
    $ok = @file_put_contents(agentpress_push_key_file(), "<?php\nreturn " . var_export($record, true) . ";\n", LOCK_EX);
    if ($ok === false) {
        return agentpress_push_fail('key_write', 'Could not write the key file under wp-content/agentpress-push-data. Check that folder is writable.', 500);
    }
    if (function_exists('opcache_invalidate')) {
        @opcache_invalidate(agentpress_push_key_file(), true);
    }
    $payload = wp_json_encode(['v' => 1, 'url' => site_url(), 'key' => $key]);
    return ['key' => $key, 'connection' => 'agentpress-push:' . rtrim(strtr(base64_encode($payload), '+/', '-_'), '=')];
}

function agentpress_push_key_revoke()
{
    @unlink(agentpress_push_key_file());
    if (function_exists('opcache_invalidate')) {
        @opcache_invalidate(agentpress_push_key_file(), true);
    }
}

function agentpress_push_is_local_host()
{
    if (function_exists('wp_get_environment_type') && wp_get_environment_type() === 'local') {
        return true;
    }
    $host = strtolower((string) wp_parse_url(site_url(), PHP_URL_HOST));
    // Not .local: that is mDNS, i.e. some OTHER device on the network, and
    // "the traffic never leaves this machine" is the whole reason for the exemption.
    return (bool) preg_match('/(\.test|\.localhost)$|^localhost$|^127\.\d+\.\d+\.\d+$/', $host);
}

/**
 * Nothing this plugin answers may ever be kept by a page cache.
 *
 * Found on the first real server (LiteSpeed + the LiteSpeed Cache plugin,
 * which caches the REST API for visitors by default): the key is a header,
 * not a WordPress login, so every request here looks like an anonymous GET.
 * The server stored the first download of manifest.ndjson and answered the
 * second one, for a DIFFERENT manifest at the same address, from that copy -
 * "96 files live does not have" when it lacked one. Worse, it handed the
 * stored copy to a request carrying NO key at all, because a cache hit never
 * reaches PHP and so never reaches the permission check. WordPress's own
 * nocache_headers() (Cache-Control: no-store, private) was already being sent
 * and was ignored: LiteSpeed obeys its own header, not that one.
 *
 * Called first thing in the permission check so a refusal is not cached
 * either. Three spellings, because no single one reaches every cache.
 */
function agentpress_push_never_cache()
{
    if (!defined('DONOTCACHEPAGE')) {
        define('DONOTCACHEPAGE', true);
    }
    // The cache plugin decides its header at the very end of the request and
    // would overwrite ours, so it has to be told in its own words as well.
    do_action('litespeed_control_set_nocache', 'agentpress-push');
    if (!headers_sent()) {
        header('X-LiteSpeed-Cache-Control: no-cache');
        nocache_headers();
    }
}

/**
 * REST permission check. The key is the whole of the auth: it is not a
 * WordPress user, on purpose, because the users table is one of the things a
 * full copy replaces mid-job.
 */
function agentpress_push_rest_permission($request)
{
    agentpress_push_never_cache();
    $record = agentpress_push_key_record();
    if (!$record) {
        return agentpress_push_fail('not_connected', 'No connection key exists on this site. Create one under Tools > AgentPress Push.', 403);
    }
    // A key sent over plain http is a key published to the network. Local
    // dev hosts are exempt: Laragon's certificate for a brand new .test site
    // is not valid until Laragon restarts, and the traffic never leaves the machine.
    if (!is_ssl() && !agentpress_push_is_local_host()) {
        return agentpress_push_fail('needs_https', 'AgentPress Push only answers over https on a public site.', 403);
    }
    // The key is compared FIRST. Checked after the throttle, as it was, ten
    // wrong guesses from an address the owner shares (an office NAT, a proxy
    // that hides the real client) locked the owner's own pushes out for ten
    // minutes at a time, in the middle of a job too. The throttle is there to
    // slow guessing, and a correct key is not a guess.
    $given = (string) $request->get_header('x_agentpress_key');
    if ($given !== '' && hash_equals($record['hash'], hash('sha256', $given))) {
        return true;
    }
    $throttle = 'agentpress_push_fail_' . md5((string) ($_SERVER['REMOTE_ADDR'] ?? ''));
    if ((int) get_transient($throttle) >= 10) {
        return agentpress_push_fail('throttled', 'Too many wrong keys from this address. Wait ten minutes.', 429);
    }
    set_transient($throttle, (int) get_transient($throttle) + 1, 10 * MINUTE_IN_SECONDS);
    return agentpress_push_fail('bad_key', 'That connection key is not the one this site holds.', 403);
}

/* ------------------------------------------------------------------------
 * Small helpers
 * --------------------------------------------------------------------- */

function agentpress_push_deadline()
{
    return microtime(true) + AGENTPRESS_PUSH_STEP_SECONDS;
}

function agentpress_push_oxygen_ready()
{
    return function_exists('\Breakdance\Data\get_meta') && defined('BREAKDANCE_BLOCK_POST_TYPE') && function_exists('\Breakdance\BreakdanceOxygen\Strings\__bdox');
}

function agentpress_push_oxygen_version()
{
    if (!function_exists('get_plugins')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    foreach (get_plugins() as $file => $data) {
        if (strpos($file, 'oxygen/') === 0 || strpos($file, 'breakdance/') === 0) {
            return (string) $data['Version'];
        }
    }
    return null;
}

/** Where each root a file may travel under lives on THIS site. */
function agentpress_push_roots()
{
    // Asked once per file in a pack; the answer cannot change inside one request.
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }
    $roots = [
        'plugins' => untrailingslashit(wp_normalize_path(WP_PLUGIN_DIR)),
        'mu-plugins' => untrailingslashit(wp_normalize_path(WPMU_PLUGIN_DIR)),
        'themes' => untrailingslashit(wp_normalize_path(get_theme_root())),
    ];
    // WordPress builds the uploads folder from the `upload_path` OPTION, and
    // an option is data: it arrives inside a copied database. Without this
    // check a pull from a site that had been tampered with could set
    // upload_path to `../scripts` (or a Startup folder) and the files that
    // follow would be written THERE, on the developer's machine (security
    // review, 2026-11-11; read end to end against core, never exploited).
    // db_swap also keeps this site's own upload_path; this is the half that
    // holds if anything else ever changes it.
    $uploads = untrailingslashit(wp_normalize_path(wp_upload_dir(null, false)['basedir']));
    if (agentpress_push_is_inside($uploads, WP_CONTENT_DIR)) {
        $roots['uploads'] = $uploads;
    }
    $cached = $roots;
    return $roots;
}

/**
 * True when $path is $base or sits under it, judged on REAL paths: `..`,
 * symlinks, doubled slashes, letter case and Windows 8.3 short names
 * (`AGENTP~1`) all resolve before the comparison. $path need not exist yet;
 * its deepest existing folder is resolved and the rest is appended.
 */
function agentpress_push_is_inside($path, $base)
{
    $base = realpath($base);
    if ($base === false) {
        return false;
    }
    $path = wp_normalize_path((string) $path);
    $tail = '';
    $probe = $path;
    while ($probe !== '' && !file_exists($probe)) {
        $parent = dirname($probe);
        if ($parent === $probe) {
            return false;
        }
        $tail = '/' . basename($probe) . $tail;
        $probe = $parent;
    }
    $real = realpath($probe);
    if ($real === false || strpos($tail, '/..') !== false) {
        return false;
    }
    $full = wp_normalize_path($real . $tail);
    $base = untrailingslashit(wp_normalize_path($base));
    $same = DIRECTORY_SEPARATOR === '\\' ? 'strcasecmp' : 'strcmp';
    return $same($full, $base) === 0 || $same(substr($full, 0, strlen($base) + 1), $base . '/') === 0;
}

/**
 * Files that could run as code if they landed under uploads/. A pull asks
 * for these to be left out (`refuse_code`): what comes down from a live site
 * is content, and content is pictures and documents. Trailing dots and
 * spaces are trimmed first because Windows drops them on write, so
 * `shell.php.` would land as `shell.php`.
 */
function agentpress_push_runs_as_code($rel)
{
    $name = rtrim((string) $rel, ". \t");
    return (bool) preg_match('#(^|/)(\.htaccess|\.user\.ini)$|\.(php[0-9]?|phtml|pht|phar|phps)$#i', $name);
}

/**
 * Paths that never travel. The receiver itself is left out so a push can
 * never replace the code that is running it.
 *
 * CODE (plugins, mu-plugins, themes) is otherwise copied exactly. The first
 * version skipped any folder called `cache`, `backup(s)` or `node_modules`
 * wherever it sat, to leave bulk behind - and Oxygen ships three classes in
 * `.../Twig/Cache/`. Every local test passed, because both test sites already
 * had Oxygen installed. The first push to a real server (2026-11-11) arrived
 * without that folder and died after the database switch with
 * `Class "...\Twig\Cache\FilesystemCache" not found`. A folder's NAME is not
 * evidence it is disposable when the folder is somebody's code. Only `.git`
 * is left out there: never runtime code, often huge.
 *
 * UPLOADS is where caches and other tools' backups really pile up, and only
 * at known places directly under it.
 */
function agentpress_push_path_skipped($rel)
{
    if (strpos($rel, 'plugins/agentpress-push/') === 0 || preg_match('#\.ap-part$#i', $rel)) {
        return true;
    }
    if (preg_match('#(^|/)\.git(/|$)#', $rel)) {
        return true;
    }
    if (strpos($rel, 'uploads/') === 0) {
        if (preg_match('#^uploads/(cache|ai1wm-backups|ai1wm-storage|updraft|wp-migrate-db|backups?)(/|$)#i', $rel)) {
            return true;
        }
        if (preg_match('#\.(log|tmp)$#i', $rel)) {
            return true;
        }
    }
    return false;
}

/** `uploads/2026/11/a.jpg` -> absolute path on this site, or WP_Error. */
function agentpress_push_resolve_path($rel)
{
    $rel = (string) $rel;
    if ($rel === '' || strpos($rel, "\0") !== false || strpos($rel, '\\') !== false || preg_match('#(^|/)\.\.?(/|$)#', $rel) || $rel[0] === '/') {
        return agentpress_push_fail('bad_path', 'Refused an unsafe file path: ' . $rel);
    }
    // An empty segment (`plugins//agentpress-push/...`) names the same file
    // to the filesystem and a different one to every prefix check here. On
    // Windows a colon opens an alternate data stream: `shell.php::$DATA`
    // writes shell.php.
    if (strpos($rel, '//') !== false || (DIRECTORY_SEPARATOR === '\\' && strpos($rel, ':') !== false)) {
        return agentpress_push_fail('bad_path', 'Refused an unsafe file path: ' . $rel);
    }
    $slash = strpos($rel, '/');
    $root = $slash === false ? '' : substr($rel, 0, $slash);
    $roots = agentpress_push_roots();
    if (!isset($roots[$root])) {
        if ($root === 'uploads') {
            return agentpress_push_fail('bad_root', "This site's uploads folder is not inside wp-content, so AgentPress Push will not read or write it. Check Settings > Media, or the upload_path option.");
        }
        return agentpress_push_fail('bad_root', 'Refused a file outside uploads, plugins, mu-plugins and themes: ' . $rel);
    }
    return $roots[$root] . substr($rel, $slash);
}

/* ------------------------------------------------------------------------
 * Pages are the design's, so on a live site only administrators edit them
 *
 * The person writing on the live site is usually a client with the Editor
 * role. Editors can edit pages, and a page is not theirs the way a story is:
 * the ones built in Oxygen are pushed from the dev site, and a change made
 * on live is replaced by the next push without anyone being told. So on a
 * site that is not a dev machine, page editing is closed to everyone but
 * administrators unless it is opened on purpose (operator's call,
 * 2026-11-12). Stories, media and comments are untouched.
 *
 * The switch is a FILE, like the connection key and for the same reason: a
 * full copy replaces the options table, and the answer must not arrive from
 * the dev site inside it.
 * --------------------------------------------------------------------- */

/** May people who are not administrators edit pages here? `$set` ('open', 'locked') changes the answer first. */
function agentpress_push_pages_open($set = null)
{
    static $cached = null;
    // Not agentpress_push_data_dir(): that creates the folder, and this is asked on every admin request.
    $file = WP_CONTENT_DIR . '/agentpress-push-data/pages-access.txt';
    if ($set === 'open' || $set === 'locked') {
        @file_put_contents(agentpress_push_data_dir() . '/pages-access.txt', $set);
        $cached = null;
    }
    if ($cached === null) {
        $state = is_file($file) ? trim((string) @file_get_contents($file)) : '';
        // Never chosen: closed on a public site, open on a dev machine, where the only person is the developer.
        $cached = $state === 'open' ? true : ($state === 'locked' ? false : agentpress_push_is_local_host());
    }
    return $cached;
}

/**
 * Takes the page capabilities away from anyone who is not an administrator
 * while pages are closed. WordPress then hides the Pages menu, the "Edit
 * page" links and the REST routes by itself: every one of them asks for
 * these. Reading a page is not touched.
 */
function agentpress_push_lock_pages($allcaps)
{
    if (!empty($allcaps['manage_options']) || agentpress_push_pages_open()) {
        return $allcaps;
    }
    foreach (['edit_pages', 'edit_others_pages', 'edit_published_pages', 'edit_private_pages', 'publish_pages', 'delete_pages', 'delete_others_pages', 'delete_published_pages', 'delete_private_pages'] as $cap) {
        if (!empty($allcaps[$cap])) {
            $allcaps[$cap] = false;
        }
    }
    return $allcaps;
}
add_filter('user_has_cap', 'agentpress_push_lock_pages', 10, 1);

/** Ask, or set, whether pages are open here. */
function agentpress_push_op_pages_access($args)
{
    $set = (string) ($args['set'] ?? '');
    if ($set !== '' && $set !== 'open' && $set !== 'locked') {
        return agentpress_push_fail('bad_state', 'Pages can be open or locked.', 422);
    }
    $open = agentpress_push_pages_open($set === '' ? null : $set);
    return ['open' => $open, 'chosen' => is_file(WP_CONTENT_DIR . '/agentpress-push-data/pages-access.txt')];
}

/* ------------------------------------------------------------------------
 * What an editor is shown in wp-admin
 *
 * The pages lock above, widened into a short list an administrator ticks
 * (operator's ask, 2026-11-12: the client should see what they need and
 * nothing that confuses them). The list is only what an Editor is really
 * shown. Checked on a site, not from memory: Dashboard, Posts, Media, Pages,
 * Comments, Profile, Tools. Appearance, Plugins, Users, Settings and Oxygen
 * need an administrator's capabilities and never appear for an editor, so
 * there is nothing to hide. Posts, Media and Profile are the job itself and
 * are not offered.
 *
 * Pages is a LOCK: the capabilities go, so every screen and route refuses.
 * The rest is TIDYING: the menu entry goes, its screens send the person back
 * to the dashboard, and that is all. Someone who can moderate comments can
 * still do it through the REST API. SECURITY.md says so.
 *
 * Administrators are never touched. Like the pages switch, the list is a
 * file: an option would arrive from the dev site inside a full copy.
 * --------------------------------------------------------------------- */

/** key => what wp-admin calls it. The order is the order it is listed in. */
function agentpress_push_editor_items()
{
    return [
        'pages' => 'Pages',
        'comments' => 'Comments',
        'tools' => 'Tools',
        'news' => 'WordPress news',
    ];
}

/** The keys hidden from non-administrators here. `$hide` and `$show` change the list first. */
function agentpress_push_editor_hidden(array $hide = [], array $show = [])
{
    static $cached = null;
    $known = array_keys(agentpress_push_editor_items());
    // Not agentpress_push_data_dir(): that creates the folder, and this is asked on every admin request.
    $file = WP_CONTENT_DIR . '/agentpress-push-data/editor-hidden.txt';
    $read = static function () use ($file, $known) {
        $kept = is_file($file) ? preg_split('/\s+/', trim((string) @file_get_contents($file)), -1, PREG_SPLIT_NO_EMPTY) : [];
        // Pages has its own switch (and its own default), so it is never kept here.
        return array_values(array_diff(array_intersect($known, (array) $kept), ['pages']));
    };
    if ($hide || $show) {
        if (in_array('pages', $show, true)) {
            agentpress_push_pages_open('open');
        } elseif (in_array('pages', $hide, true)) {
            agentpress_push_pages_open('locked');
        }
        $now = array_diff(array_unique(array_merge($read(), $hide)), $show, ['pages']);
        @file_put_contents(agentpress_push_data_dir() . '/editor-hidden.txt', implode("\n", array_values(array_intersect($known, $now))));
        $cached = null;
    }
    if ($cached === null) {
        $cached = $read();
    }
    return agentpress_push_pages_open() ? $cached : array_merge(['pages'], $cached);
}

/** Is the person asking someone this list applies to? Never an administrator. */
function agentpress_push_editor_limited()
{
    return is_user_logged_in() && !current_user_can('manage_options');
}

function agentpress_push_editor_menu()
{
    if (!agentpress_push_editor_limited()) {
        return;
    }
    $hidden = agentpress_push_editor_hidden();
    if (in_array('comments', $hidden, true)) {
        remove_menu_page('edit-comments.php');
    }
    if (in_array('tools', $hidden, true)) {
        remove_menu_page('tools.php');
    }
}
add_action('admin_menu', 'agentpress_push_editor_menu', 999);

/** The wp-admin files behind each hidden entry. A bookmark or a typed address lands on the dashboard instead. */
function agentpress_push_editor_blocked_screens(array $hidden)
{
    $screens = [];
    if (in_array('comments', $hidden, true)) {
        $screens = array_merge($screens, ['edit-comments.php', 'comment.php']);
    }
    if (in_array('tools', $hidden, true)) {
        $screens = array_merge($screens, ['tools.php', 'import.php', 'export.php', 'site-health.php', 'export-personal-data.php', 'erase-personal-data.php']);
    }
    return $screens;
}

function agentpress_push_editor_screens()
{
    global $pagenow;
    if (wp_doing_ajax() || !agentpress_push_editor_limited()) {
        return;
    }
    if (in_array((string) $pagenow, agentpress_push_editor_blocked_screens(agentpress_push_editor_hidden()), true)) {
        wp_safe_redirect(admin_url());
        exit;
    }
}
add_action('admin_init', 'agentpress_push_editor_screens');

function agentpress_push_editor_toolbar($bar)
{
    if (!agentpress_push_editor_limited()) {
        return;
    }
    $hidden = agentpress_push_editor_hidden();
    if (in_array('comments', $hidden, true)) {
        $bar->remove_node('comments');
    }
    if (in_array('news', $hidden, true)) {
        // The W menu: About WordPress, documentation, forums. Same family as the news box.
        $bar->remove_node('wp-logo');
    }
}
add_action('admin_bar_menu', 'agentpress_push_editor_toolbar', 999);

function agentpress_push_editor_dashboard()
{
    if (agentpress_push_editor_limited() && in_array('news', agentpress_push_editor_hidden(), true)) {
        remove_meta_box('dashboard_primary', 'dashboard', 'side');
    }
}
add_action('wp_dashboard_setup', 'agentpress_push_editor_dashboard', 999);

/** Ask, or change, what editors are shown here. `hide` and `show` are lists of keys. */
function agentpress_push_op_editor_view($args)
{
    $items = agentpress_push_editor_items();
    $hide = array_values(array_map('strval', (array) ($args['hide'] ?? [])));
    $show = array_values(array_map('strval', (array) ($args['show'] ?? [])));
    foreach (array_merge($hide, $show) as $key) {
        if (!isset($items[$key])) {
            return agentpress_push_fail('bad_item', 'Not something that can be hidden here: ' . sanitize_key($key) . '. It can be: ' . implode(', ', array_keys($items)) . '.', 422);
        }
    }
    if (array_intersect($hide, $show)) {
        return agentpress_push_fail('bad_item', 'The same thing cannot be both hidden and shown.', 422);
    }
    $hidden = agentpress_push_editor_hidden($hide, $show);
    $list = [];
    foreach ($items as $key => $label) {
        $list[] = ['key' => $key, 'label' => $label, 'hidden' => in_array($key, $hidden, true)];
    }
    return ['items' => $list];
}

/* ------------------------------------------------------------------------
 * info
 * --------------------------------------------------------------------- */

/**
 * Every plugin here: its folder, version, whether it is switched on, whether
 * it updates itself, and the version waiting if one is. For `push status`: a
 * live site with auto-updates on drifts ahead of the dev site without anyone
 * touching it, and the design is then tested against older code than runs it.
 */
function agentpress_push_plugin_list()
{
    if (!function_exists('get_plugins')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    $auto = (array) get_site_option('auto_update_plugins', []);
    $waiting = get_site_transient('update_plugins');
    $waiting = is_object($waiting) && isset($waiting->response) ? (array) $waiting->response : [];
    $list = [];
    foreach (get_plugins() as $file => $data) {
        $slash = strpos($file, '/');
        $list[] = [
            'dir' => $slash === false ? (string) $file : substr($file, 0, $slash),
            'name' => (string) ($data['Name'] ?? $file),
            'version' => (string) ($data['Version'] ?? ''),
            'active' => is_plugin_active($file),
            'auto' => in_array($file, $auto, true),
            'update' => is_object($waiting[$file] ?? null) && isset($waiting[$file]->new_version) ? (string) $waiting[$file]->new_version : '',
        ];
    }
    return $list;
}

function agentpress_push_op_info()
{
    global $wpdb;
    agentpress_push_sweep_sessions();
    $counts = [];
    foreach (['post', 'page', 'attachment'] as $type) {
        $counts[$type] = (int) $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = %s AND post_status NOT IN ('auto-draft','trash')", $type));
    }
    $counts['users'] = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->users}");
    $counts['comments'] = (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->comments}");
    $free = @disk_free_space(WP_CONTENT_DIR);
    $design = agentpress_push_oxygen_ready() ? agentpress_push_design_bundle(false) : null;
    // The theme folders this site really runs on. A design push sends only
    // these: on the first real site the default themes had been removed from
    // live on purpose, and every design push offered all 393 files back
    // (2026-11-12). Oxygen with its theme switch off reports `oxygen-zero`,
    // a folder inside the Oxygen plugin: a real theme to WordPress, and nothing
    // under wp-content/themes, so no theme folder travels at all.
    $themes = [];
    foreach ([get_stylesheet(), get_template()] as $slug) {
        $slug = (string) $slug;
        if (preg_match('/^[A-Za-z0-9._-]+$/', $slug) && $slug !== '.' && $slug !== '..' && is_dir(get_theme_root($slug) . '/' . $slug)) {
            $themes[$slug] = true;
        }
    }
    return [
        'themes_in_use' => array_map('strval', array_keys($themes)),
        'plugin_version' => AGENTPRESS_PUSH_VERSION,
        'format' => AGENTPRESS_PUSH_FORMAT,
        'site_url' => site_url(),
        'home_url' => home_url(),
        'name' => get_bloginfo('name'),
        'wp_version' => get_bloginfo('version'),
        'oxygen_version' => agentpress_push_oxygen_version(),
        'oxygen_ready' => agentpress_push_oxygen_ready(),
        'php_version' => PHP_VERSION,
        'post_max_bytes' => wp_convert_hr_to_bytes((string) ini_get('post_max_size')),
        'max_execution_time' => (int) ini_get('max_execution_time'),
        'disk_free_bytes' => $free === false ? null : (float) $free,
        'prefix' => $wpdb->prefix,
        'counts' => $counts,
        // A stock install: the sample post and page, one user, one comment.
        // The first full copy only skips its "type the site name" confirmation
        // when the target still looks like this.
        'looks_fresh' => $counts['post'] <= 1 && $counts['page'] <= 2 && $counts['attachment'] === 0 && $counts['users'] <= 1 && $counts['comments'] <= 1,
        'has_undo' => agentpress_push_tables(AGENTPRESS_PUSH_OLD . $wpdb->prefix) !== [],
        'design_items' => $design ? count($design['items']) : 0,
        'design_hash' => $design ? agentpress_push_design_hash($design) : null,
        'is_local' => agentpress_push_is_local_host(),
        // Which live site this site's story notes were taken against, and
        // how many stories here carry no note (written here, never sent).
        // The count means nothing until the first is the site being asked about.
        'stories_synced_with' => (string) get_option(AGENTPRESS_PUSH_STORIES_SYNCED, ''),
        'stories_unsent' => agentpress_push_stories_unsent(),
        // For `push status`, which is where two sites that should match are
        // found not to. None of it is used to decide anything.
        'plugins' => agentpress_push_plugin_list(),
        'search_visible' => (bool) get_option('blog_public'),
        'memory_limit' => (string) ini_get('memory_limit'),
        'upload_max_bytes' => (float) wp_max_upload_size(),
        'pages_open' => agentpress_push_pages_open(),
        'editor_hidden' => agentpress_push_editor_hidden(),
    ];
}

/* ------------------------------------------------------------------------
 * Sessions and chunks
 * --------------------------------------------------------------------- */

function agentpress_push_op_session_new()
{
    $session = bin2hex(random_bytes(16));
    $dir = agentpress_push_session_dir($session, true);
    if (is_wp_error($dir)) {
        return $dir;
    }
    agentpress_push_sweep_sessions($dir);
    return ['session' => $session, 'dir' => wp_normalize_path($dir)];
}

/**
 * Removes job folders nothing has written to for six hours. A job that was
 * killed (Ctrl+C, a closed terminal, a dropped connection) cannot clean up
 * after itself, and what it leaves is a database export: every user's email
 * and password hash. The sweep used to wait a day and ran only when a NEW
 * job started, so a site pushed to once kept that file until the next push,
 * possibly for good. Now it also runs on every `info`, which every command
 * begins with. Age is judged by the newest file inside, not the folder: a
 * long upload appends to one file and never touches the folder's own time.
 */
function agentpress_push_sweep_sessions($except = '')
{
    $cutoff = time() - 6 * HOUR_IN_SECONDS;
    foreach (glob(agentpress_push_data_dir() . '/s-*', GLOB_ONLYDIR) ?: [] as $old) {
        if ($old === $except) {
            continue;
        }
        $newest = (int) @filemtime($old);
        foreach (glob($old . '/*') ?: [] as $inside) {
            $newest = max($newest, (int) @filemtime($inside));
        }
        if ($newest < $cutoff) {
            agentpress_push_rrmdir($old);
        }
    }
}

function agentpress_push_op_session_end($args)
{
    $dir = agentpress_push_session_dir($args['session'] ?? '');
    if (is_wp_error($dir)) {
        return ['removed' => false];
    }
    agentpress_push_rrmdir($dir);
    return ['removed' => true];
}

/**
 * Append one chunk. `offset` must be where the file currently ends, which
 * makes a retried chunk harmless: a chunk that fits inside what is already
 * written is acknowledged, anything else is refused rather than guessed at.
 */
function agentpress_push_put($session, $name, $offset, $bytes)
{
    $dir = agentpress_push_session_dir($session);
    if (is_wp_error($dir)) {
        return $dir;
    }
    if (!in_array($name, agentpress_push_session_files(), true)) {
        return agentpress_push_fail('bad_name', 'Not a file this session accepts.');
    }
    $path = $dir . '/' . $name;
    clearstatcache(true, $path);
    $offset = (int) $offset;
    if ($offset === 0 && is_file($path)) {
        // Offset 0 always starts the file again. A session is reused within
        // one push (a manifest, then a pack, then another), and a retried
        // first chunk rewrites the same bytes, so this is safe either way.
        @unlink($path);
        clearstatcache(true, $path);
    }
    $size = is_file($path) ? filesize($path) : 0;
    if ($offset + strlen($bytes) <= $size && $offset < $size) {
        return ['size' => $size, 'repeat' => true];
    }
    if ($offset !== $size) {
        return agentpress_push_fail('bad_offset', "Chunk offset $offset does not match the $size bytes already received.", 409);
    }
    if (file_put_contents($path, $bytes, FILE_APPEND | LOCK_EX) !== strlen($bytes)) {
        return agentpress_push_fail('write_failed', 'Could not write the chunk. The account may be out of disk space.', 507);
    }
    return ['size' => $size + strlen($bytes)];
}

/* ------------------------------------------------------------------------
 * Database: export
 * --------------------------------------------------------------------- */

/** Every table whose name starts with `$prefix`, exactly as MySQL spells it. */
function agentpress_push_tables($prefix)
{
    global $wpdb;
    $names = $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($prefix) . '%'));
    return array_values(array_filter((array) $names, function ($name) use ($prefix) {
        return strpos($name, $prefix) === 0;
    }));
}

/**
 * Tables that belong to the INSTALL they are on and never travel with a
 * copy, by their name without the prefix. The caller names them (`own_tables`),
 * the way it names the agent plugins' folders.
 *
 * Found by the first full copy onto a server after a pull (2026-11-12): the
 * local agent connector keeps OAuth clients, codes and tokens in three tables
 * of its own, and they went up with everything else. They were empty that
 * day. On a site whose agent signs in with OAuth they are its credentials,
 * arriving on a public server whose copy of the plugin is not even switched
 * on, and `undo` left the tables there: it only swaps back what the kept set
 * names. The plugin's files and its place in the active list were already
 * local-only; its data was the half nobody had listed.
 *
 * Whole names, never a pattern: `acfw_` is also the prefix of a coupons plugin
 * for WooCommerce, and a pattern would leave a shop's own tables behind.
 */
function agentpress_push_own_tables($args)
{
    $names = [];
    foreach ((array) ($args['own_tables'] ?? []) as $name) {
        if (is_string($name) && preg_match('/^[A-Za-z0-9_]+$/', $name)) {
            $names[] = $name;
        }
    }
    return $names;
}

/**
 * LIKE patterns for the options that stay with the install the same way
 * (`own_option_prefixes`), each with the two spellings WordPress stores a
 * transient of that name under.
 */
function agentpress_push_own_option_likes($args)
{
    global $wpdb;
    $likes = [];
    foreach ((array) ($args['own_option_prefixes'] ?? []) as $prefix) {
        if (is_string($prefix) && preg_match('/^[A-Za-z0-9_]+$/', $prefix)) {
            foreach (['', '_transient_', '_transient_timeout_'] as $lead) {
                $likes[] = $wpdb->esc_like($lead . $prefix) . '%';
            }
        }
    }
    return $likes;
}

/** One cell, JSON-safe. Bytes that are not UTF-8 (a BLOB) ride as base64. */
function agentpress_push_cell_out($value)
{
    if ($value === null) {
        return null;
    }
    $value = (string) $value;
    return mb_check_encoding($value, 'UTF-8') ? $value : ['b' => base64_encode($value)];
}

/**
 * Writes the database as one JSON object per line: a `meta` line, then for
 * each table a `table` line carrying its CREATE statement and `r` lines
 * carrying rows. Not a .sql dump on purpose: importing SQL text means
 * splitting statements, and every splitter eventually meets a post whose
 * body contains `');` and cuts it in half.
 */
function agentpress_push_op_db_export($args)
{
    global $wpdb;
    $dir = agentpress_push_session_dir($args['session'] ?? '');
    if (is_wp_error($dir)) {
        return $dir;
    }
    $state = is_array($args['state'] ?? null) ? $args['state'] : [];
    $state += ['tables' => null, 't' => 0, 'offset' => 0, 'rows' => 0];
    $path = $dir . '/db.ndjson';
    $prefix = $wpdb->prefix;

    if ($state['tables'] === null) {
        // Not read at all, so a token never reaches the export file either.
        $own = agentpress_push_own_tables($args);
        $state['tables'] = array_values(array_filter(agentpress_push_tables($prefix), function ($table) use ($prefix, $own) {
            return !in_array(substr($table, strlen($prefix)), $own, true);
        }));
        $meta =['t' => 'meta', 'format' => AGENTPRESS_PUSH_FORMAT, 'prefix' => $prefix, 'site_url' => site_url(), 'home_url' => home_url(), 'tables' => count($state['tables'])];
        file_put_contents($path, wp_json_encode($meta, JSON_UNESCAPED_SLASHES) . "\n");
    }
    $out = fopen($path, 'ab');
    if (!$out) {
        return agentpress_push_fail('export_open', 'Could not open the export file for writing.', 500);
    }
    $deadline = agentpress_push_deadline();
    $flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;

    while ($state['t'] < count($state['tables']) && microtime(true) < $deadline) {
        $table = $state['tables'][$state['t']];
        if ($state['offset'] === 0) {
            $create = $wpdb->get_row("SHOW CREATE TABLE `$table`", ARRAY_N);
            if (!$create || empty($create[1])) {
                fclose($out);
                return agentpress_push_fail('export_create', "Could not read the structure of $table.", 500);
            }
            // {{P}} stands for the prefix everywhere it appears, including
            // inside constraint names, so the importer can land the table
            // under any prefix it likes.
            $sql = str_replace('`' . $prefix, '`{{P}}', $create[1]);
            $keys = $wpdb->get_results("SHOW KEYS FROM `$table` WHERE Key_name = 'PRIMARY'", ARRAY_A);
            usort($keys, function ($a, $b) { return (int) $a['Seq_in_index'] - (int) $b['Seq_in_index']; });
            $state['order'] = $keys ? ' ORDER BY ' . implode(', ', array_map(function ($k) { return '`' . $k['Column_name'] . '`'; }, $keys)) : '';
            fwrite($out, wp_json_encode(['t' => 'table', 'name' => substr($table, strlen($prefix)), 'create' => $sql], $flags) . "\n");
        }
        // Paging by OFFSET is only stable with a fixed order; a table with no
        // primary key is read in one pass instead of risking a skipped row.
        $limit = $state['order'] === '' ? 1000000000 : 400;
        $rows = $wpdb->get_results("SELECT * FROM `$table`{$state['order']} LIMIT $limit OFFSET " . (int) $state['offset'], ARRAY_N);
        if ($rows === null && $wpdb->last_error) {
            fclose($out);
            return agentpress_push_fail('export_read', "Reading $table failed: " . $wpdb->last_error, 500);
        }
        foreach ((array) $rows as $row) {
            $line = wp_json_encode(['r' => array_map('agentpress_push_cell_out', $row)], $flags);
            if ($line === false) {
                fclose($out);
                return agentpress_push_fail('export_encode', "A row of $table could not be encoded.", 500);
            }
            fwrite($out, $line . "\n");
        }
        $state['rows'] += count((array) $rows);
        if (count((array) $rows) < $limit) {
            $state['t']++;
            $state['offset'] = 0;
        } else {
            $state['offset'] += $limit;
        }
        $wpdb->flush();
    }
    fclose($out);
    clearstatcache(true, $path);
    $done = $state['t'] >= count($state['tables']);
    return ['done' => $done, 'state' => $state, 'tables_done' => $state['t'], 'tables' => count($state['tables']), 'rows' => $state['rows'], 'bytes' => filesize($path)];
}

/* ------------------------------------------------------------------------
 * Database: replacing one site's address with the other's
 * --------------------------------------------------------------------- */

/** old => new for every spelling a URL is stored in: plain, JSON-escaped, URL-encoded. */
function agentpress_push_url_pairs($from_urls, $to_url)
{
    $to_url = untrailingslashit($to_url);
    $pairs = [];
    foreach (array_unique(array_filter((array) $from_urls)) as $from) {
        $host = preg_replace('#^https?://#i', '', untrailingslashit($from));
        foreach (['https://' . $host, 'http://' . $host] as $old) {
            if ($old === $to_url) {
                continue;
            }
            $pairs[$old] = $to_url;
            $pairs[str_replace('/', '\\/', $old)] = str_replace('/', '\\/', $to_url);
            $pairs[rawurlencode($old)] = rawurlencode($to_url);
        }
    }
    return $pairs;
}

/**
 * Replace inside one stored value. A PHP-serialized value carries the byte
 * length of every string, so a plain search-and-replace that changes a URL's
 * length corrupts it and WordPress then reads the whole option as `false` -
 * the classic "all my widgets vanished after the move". Serialized values are
 * unpacked, changed, and packed again so the lengths come out right.
 */
function agentpress_push_replace_value($value, $pairs)
{
    if (!is_string($value) || $value === '' || !$pairs) {
        return $value;
    }
    $hit = false;
    foreach ($pairs as $old => $new) {
        if (strpos($value, (string) $old) !== false) {
            $hit = true;
            break;
        }
    }
    if (!$hit) {
        return $value;
    }
    if (is_serialized($value)) {
        // allowed_classes=false: never instantiate a class named by data that
        // arrived over the network. Objects come back as incomplete-class
        // shells, which are left exactly as they were.
        $data = @unserialize($value, ['allowed_classes' => false]);
        if ($data !== false || $value === 'b:0;') {
            return serialize(agentpress_push_replace_deep($data, $pairs));
        }
    }
    return strtr($value, $pairs);
}

function agentpress_push_replace_deep($data, $pairs)
{
    if (is_string($data)) {
        return agentpress_push_replace_value($data, $pairs);
    }
    if (is_array($data)) {
        foreach ($data as $key => $item) {
            $data[$key] = agentpress_push_replace_deep($item, $pairs);
        }
    }
    return $data;
}

/* ------------------------------------------------------------------------
 * Database: import, swap, undo
 * --------------------------------------------------------------------- */

/**
 * usermeta keys and the one option that carry the table prefix in their NAME.
 * A copy between two prefixes has to rename them or every user arrives with
 * no role. Listed, not pattern-matched: with the stock `wp_` prefix a pattern
 * would also catch `wp_page_for_privacy_policy` and friends.
 */
function agentpress_push_prefixed_user_keys()
{
    return ['capabilities', 'user_level', 'user-settings', 'user-settings-time', 'dashboard_quick_press_last_post_id', 'persisted_preferences'];
}

function agentpress_push_insert_rows($table, $rows)
{
    global $wpdb;
    if (!$rows) {
        return true;
    }
    $tuples = [];
    foreach ($rows as $row) {
        $cells = [];
        foreach ($row as $cell) {
            $cells[] = $cell === null ? 'NULL' : "'" . mysqli_real_escape_string($wpdb->dbh, $cell) . "'";
        }
        $tuples[] = '(' . implode(',', $cells) . ')';
    }
    // mysqli directly, not $wpdb->query(): wpdb rewrites every literal % in a
    // query into a placeholder hash, and post content is full of them.
    if (!mysqli_query($wpdb->dbh, "INSERT INTO `$table` VALUES " . implode(',', $tuples))) {
        return agentpress_push_fail('import_insert', "Writing rows into $table failed: " . mysqli_error($wpdb->dbh), 500);
    }
    return true;
}

/**
 * Loads db.ndjson into tables named apnew_<prefix><name>, beside the live
 * ones. The live site keeps serving from its own tables the whole time; only
 * db_swap, one atomic rename, makes the new copy current. An upload that
 * dies halfway therefore leaves the site exactly as it was.
 */
function agentpress_push_op_db_import($args)
{
    global $wpdb;
    $dir = agentpress_push_session_dir($args['session'] ?? '');
    if (is_wp_error($dir)) {
        return $dir;
    }
    if (!($wpdb->dbh instanceof mysqli)) {
        return agentpress_push_fail('needs_mysqli', 'This site is not using the mysqli database driver.', 500);
    }
    $path = $dir . '/db.ndjson';
    $in = is_file($path) ? fopen($path, 'rb') : false;
    if (!$in) {
        return agentpress_push_fail('import_missing', 'No database export has been uploaded to this session.');
    }
    $state = is_array($args['state'] ?? null) ? $args['state'] : [];
    $state += ['pos' => 0, 'table' => '', 'name' => '', 'rows' => 0, 'tables' => 0, 'meta' => null, 'skip' => false, 'skipped_tables' => 0, 'skipped_rows' => 0];
    // The sender leaves these out of its export. Asked again here because on
    // a pull the sender is the live site, and what it sends is checked, not
    // believed: a table of the agent connector's arriving from there would
    // replace this site's own, sign-in tokens and all.
    $own_tables = agentpress_push_own_tables($args);
    $prefix = $wpdb->prefix;
    $new_prefix = AGENTPRESS_PUSH_NEW . $prefix;

    // Zero dates and id 0 rows are legal in a WordPress database but refused
    // by the strict modes most servers default to.
    mysqli_query($wpdb->dbh, "SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'");
    mysqli_query($wpdb->dbh, 'SET SESSION foreign_key_checks = 0');

    if ($state['pos'] === 0) {
        // Leftovers of an import that never reached its swap. Ours by name, never live data.
        foreach (agentpress_push_tables($new_prefix) as $stale) {
            mysqli_query($wpdb->dbh, "DROP TABLE IF EXISTS `$stale`");
        }
    }
    fseek($in, $state['pos']);
    // One transaction per step. Left on autocommit, every INSERT is its own
    // flush to disk, and on the first timed run that made a 6.7 MB database
    // take 46 seconds to load. (CREATE TABLE commits implicitly; that is fine,
    // a step resumes from `pos`, which only ever advances past flushed rows.)
    mysqli_query($wpdb->dbh, 'START TRANSACTION');
    $deadline = agentpress_push_deadline();
    $batch = [];
    $batch_bytes = 0;
    $pairs = $state['meta'] ? agentpress_push_url_pairs([$state['meta']['site_url'], $state['meta']['home_url']], site_url()) : [];
    $source_prefix = $state['meta'] ? (string) $state['meta']['prefix'] : '';
    $done = false;

    $flush = function () use (&$batch, &$batch_bytes, &$state) {
        $result = agentpress_push_insert_rows($state['table'], $batch);
        $state['rows'] += count($batch);
        $batch = [];
        $batch_bytes = 0;
        return $result;
    };

    while (true) {
        $line = fgets($in);
        if ($line === false) {
            $done = true;
            break;
        }
        $record = json_decode($line, true);
        if (!is_array($record)) {
            fclose($in);
            return agentpress_push_fail('import_corrupt', 'The uploaded database export is damaged (a line is not valid JSON). Nothing on this site was changed.', 422);
        }
        if (isset($record['r'])) {
            if ($state['skip']) {
                $state['skipped_rows']++;
                continue;
            }
            $row = [];
            foreach ($record['r'] as $i => $cell) {
                if (is_array($cell)) {
                    $row[] = base64_decode((string) ($cell['b'] ?? ''));
                    continue;
                }
                if (is_string($cell) && $source_prefix !== $prefix) {
                    if ($state['name'] === 'usermeta' && $i === 2 && strpos($cell, $source_prefix) === 0 && in_array(substr($cell, strlen($source_prefix)), agentpress_push_prefixed_user_keys(), true)) {
                        $cell = $prefix . substr($cell, strlen($source_prefix));
                    } elseif ($state['name'] === 'options' && $i === 1 && $cell === $source_prefix . 'user_roles') {
                        $cell = $prefix . 'user_roles';
                    }
                }
                $row[] = $cell === null ? null : agentpress_push_replace_value((string) $cell, $pairs);
            }
            $batch[] = $row;
            $batch_bytes += strlen($line);
            if ($batch_bytes > 786432 || count($batch) >= 400) {
                $result = $flush();
                if (is_wp_error($result)) {
                    fclose($in);
                    return $result;
                }
                $state['pos'] = ftell($in);
                if (microtime(true) >= $deadline) {
                    break;
                }
            }
            continue;
        }
        // A meta or table line: finish the table before it first.
        $result = $flush();
        if (is_wp_error($result)) {
            fclose($in);
            return $result;
        }
        if (($record['t'] ?? '') === 'meta') {
            if ((int) ($record['format'] ?? 0) !== AGENTPRESS_PUSH_FORMAT) {
                fclose($in);
                return agentpress_push_fail('import_format', 'The export was made by a different version of AgentPress Push. Update the plugin on both sites.', 422);
            }
            $state['meta'] = ['prefix' => (string) $record['prefix'], 'site_url' => (string) $record['site_url'], 'home_url' => (string) $record['home_url']];
            $pairs = agentpress_push_url_pairs([$state['meta']['site_url'], $state['meta']['home_url']], site_url());
            $source_prefix = $state['meta']['prefix'];
        } elseif (($record['t'] ?? '') === 'table') {
            if (!$state['meta'] || !preg_match('/^[A-Za-z0-9_]+$/', (string) $record['name'])) {
                fclose($in);
                return agentpress_push_fail('import_corrupt', 'The uploaded database export is damaged (unexpected table record).', 422);
            }
            $state['skip'] = in_array((string) $record['name'], $own_tables, true);
            if ($state['skip']) {
                // Counted, so the caller can still see every row accounted for.
                $state['skipped_tables']++;
                $state['table'] = '';
                $state['name'] = '';
                $state['pos'] = ftell($in);
                continue;
            }
            $table = $new_prefix . $record['name'];
            if (strlen($table) > 64) {
                fclose($in);
                return agentpress_push_fail('import_name', "Table name $table is longer than MySQL allows.", 422);
            }
            // The definition is run as SQL, so it has to BE a definition of
            // this table and nothing else. Unchecked, the one statement here
            // could be `DROP TABLE` or `UPDATE ...users` against the tables the
            // site is running on, before anything was made current - breaking
            // the promise that a failed upload leaves the site as it was.
            if (!preg_match('/^CREATE TABLE `\{\{P\}\}' . preg_quote((string) $record['name'], '/') . '` \(/', (string) $record['create'])) {
                fclose($in);
                return agentpress_push_fail('import_corrupt', 'The uploaded database export is damaged (' . $record['name'] . ' is not a plain table definition). Views do not travel.', 422);
            }
            $sql = str_replace('`{{P}}', '`' . $new_prefix, (string) $record['create']);
            if (!mysqli_query($wpdb->dbh, $sql)) {
                // MySQL 8's default collation does not exist on MariaDB or
                // MySQL 5.7, which is what most shared hosts still run.
                $fallback = str_replace(['utf8mb4_0900_ai_ci', 'utf8mb4_0900_as_cs'], 'utf8mb4_unicode_520_ci', $sql);
                if ($fallback === $sql || !mysqli_query($wpdb->dbh, $fallback)) {
                    $error = mysqli_error($wpdb->dbh);
                    fclose($in);
                    return agentpress_push_fail('import_create', "Creating $table failed: $error", 500);
                }
            }
            $state['table'] = $table;
            $state['name'] = (string) $record['name'];
            $state['tables']++;
        }
        $state['pos'] = ftell($in);
        if (microtime(true) >= $deadline) {
            break;
        }
    }
    $result = $flush();
    if (is_wp_error($result)) {
        fclose($in);
        return $result;
    }
    if (!mysqli_query($wpdb->dbh, 'COMMIT')) {
        $error = mysqli_error($wpdb->dbh);
        fclose($in);
        return agentpress_push_fail('import_commit', 'Saving the loaded rows failed: ' . $error, 500);
    }
    $state['pos'] = ftell($in);
    fclose($in);
    return ['done' => $done, 'state' => $state, 'rows' => $state['rows'], 'tables' => $state['tables'], 'skipped_rows' => $state['skipped_rows'], 'skipped_tables' => $state['skipped_tables'], 'bytes_done' => $state['pos'], 'bytes' => filesize($path)];
}

/**
 * Options that belong to THIS install and survive a copy landing on it: its
 * own address, whether search engines may index it, who its admin is, and
 * everything Oxygen itself refuses to export (the license, API keys, the
 * agent-access switches).
 */
function agentpress_push_kept_option_names()
{
    $names = ['siteurl', 'home', 'blog_public', 'admin_email', 'new_admin_email'];
    if (function_exists('\Breakdance\Settings\options_excluded_from_export') && function_exists('\Breakdance\BreakdanceOxygen\Strings\__bdox')) {
        $oxy = \Breakdance\BreakdanceOxygen\Strings\__bdox('meta_prefix');
        foreach ((array) \Breakdance\Settings\options_excluded_from_export() as $name) {
            // The caches describe the OLD rows; carrying them over would pin stale CSS.
            if (strpos((string) $name, 'cache') === false) {
                $names[] = $oxy . $name;
            }
        }
    }
    return $names;
}

/**
 * Page-cache plugins, by folder, with the pattern their settings are stored
 * under (null where they live in files, not options). They belong to the
 * SERVER, not to the site being copied, so a site that runs one keeps running
 * it through a full copy.
 *
 * Found on the first real push (cPanel + LiteSpeed, 2026-11-11). The host's
 * installer had switched LiteSpeed Cache on; the copied database did not list
 * it, so it arrived switched OFF. The web server went on serving its cached
 * pages - the home page was the empty "My WordPress Blog" from before the
 * push, `X-LiteSpeed-Cache: hit` - with no plugin left to clear them when a
 * story is published. Only LiteSpeed has been seen live; the others are here
 * because they fail the same way (a cache that outlives its plugin).
 */
function agentpress_push_page_cache_plugins()
{
    return [
        'litespeed-cache' => 'litespeed.%',
        'wp-rocket' => 'wp_rocket_%',
        'w3-total-cache' => null,
        'wp-super-cache' => null,
        'wp-fastest-cache' => 'WpFastestCache%',
    ];
}

/**
 * Tell every page cache in front of this site to forget it. Called the moment
 * the content changes (swap, undo) as well as at the end, so a job that stops
 * halfway never leaves visitors on the old site's pages.
 *
 * LiteSpeed's cache belongs to the web server: it honours an
 * `X-LiteSpeed-Purge` response header from any script on the site, whether
 * or not the LiteSpeed Cache plugin is active. That matters because right
 * after a swap the plugin may not be loaded in this request at all.
 */
function agentpress_push_purge_page_cache()
{
    $done = [];
    $server = (string) ($_SERVER['SERVER_SOFTWARE'] ?? '');
    if (!headers_sent() && (stripos($server, 'litespeed') !== false || isset($_SERVER['X-LSCACHE']))) {
        header('X-LiteSpeed-Purge: *');
        $done[] = 'litespeed server cache';
    }
    if (has_action('litespeed_purge_all')) {
        do_action('litespeed_purge_all');
        $done[] = 'litespeed cache';
    }
    if (function_exists('rocket_clean_domain')) {
        rocket_clean_domain();
        $done[] = 'wp rocket cache';
    }
    if (function_exists('w3tc_flush_all')) {
        w3tc_flush_all();
        $done[] = 'w3 total cache';
    }
    return $done;
}

/**
 * The one moment the site changes: every apnew_ table takes its live
 * table's name and the live table steps aside as apold_, in a single RENAME
 * that MySQL performs atomically. apold_ is the undo.
 *
 * Then the things that must not change hands are put back: this site's own
 * settings, and its administrators' logins. Without the second, the first
 * push to a live site would replace its admin password with the local dev
 * site's throwaway one, and a pull would lock the local agent wiring out.
 */
function agentpress_push_op_db_swap($args)
{
    global $wpdb;
    $prefix = $wpdb->prefix;
    $new_prefix = AGENTPRESS_PUSH_NEW . $prefix;
    $old_prefix = AGENTPRESS_PUSH_OLD . $prefix;
    $incoming = agentpress_push_tables($new_prefix);
    $names = array_map(function ($t) use ($new_prefix) { return substr($t, strlen($new_prefix)); }, $incoming);
    foreach (['options', 'posts', 'postmeta', 'users', 'usermeta', 'terms'] as $must) {
        if (!in_array($must, $names, true)) {
            return agentpress_push_fail('swap_incomplete', "The uploaded database has no $must table, so it was not made current. Nothing on this site was changed.", 422);
        }
    }
    foreach (['options', 'users'] as $must) {
        if ((int) $wpdb->get_var("SELECT COUNT(*) FROM `{$new_prefix}{$must}`") === 0) {
            return agentpress_push_fail('swap_empty', "The uploaded $must table is empty, so it was not made current. Nothing on this site was changed.", 422);
        }
    }

    // What this site keeps. Read BEFORE the swap, from the tables about to step aside.
    $kept_options = [];
    foreach (agentpress_push_kept_option_names() as $name) {
        $row = $wpdb->get_row($wpdb->prepare("SELECT option_value, autoload FROM {$wpdb->options} WHERE option_name = %s", $name), ARRAY_A);
        if ($row) {
            $kept_options[$name] = $row;
        }
    }
    // Options that are this INSTALL's, where "the copy had none" must also
    // win: an upload path names a folder on this machine (see
    // agentpress_push_roots for what a copied one could do), and on a pull
    // the theme named by the copy is not here, because theme files only ever
    // travel up. WordPress includes <template>/functions.php from that option
    // without checking it, so a copied value is a file the copy chose.
    $own_names = ['upload_path', 'upload_url_path'];
    if (!empty($args['keep_theme'])) {
        $own_names = array_merge($own_names, ['template', 'stylesheet', 'current_theme']);
    }
    $own_options = [];
    foreach ($own_names as $name) {
        $own_options[$name] = $wpdb->get_row($wpdb->prepare("SELECT option_value, autoload FROM {$wpdb->options} WHERE option_name = %s", $name), ARRAY_A);
    }
    // The settings that go with `own_tables`: this site's stay, the copy's do
    // not arrive, and where this site had none the copy's are removed. The
    // first full copy left the dev site's agent-connector settings on the
    // live server (its switch set to on, and the dev machine's hostname).
    // The other way round, a pull from a live site that never had them took
    // this site's away, which is the agent wiring a pull says it keeps.
    $install_likes = agentpress_push_own_option_likes($args);
    $install_rows = [];
    foreach ($install_likes as $like) {
        foreach ((array) $wpdb->get_results($wpdb->prepare("SELECT option_name, option_value, autoload FROM {$wpdb->options} WHERE option_name LIKE %s", $like), ARRAY_A) as $row) {
            $install_rows[$row['option_name']] = $row;
        }
    }
    $active_here = (array) get_option('active_plugins', []);
    // A page-cache plugin this site is running keeps its own settings too, or
    // it would come back switched on with none (see agentpress_push_page_cache_plugins).
    foreach ($active_here as $file) {
        $like = is_string($file) ? (agentpress_push_page_cache_plugins()[strtok($file, '/')] ?? null) : null;
        if ($like) {
            foreach ((array) $wpdb->get_results($wpdb->prepare("SELECT option_name, option_value, autoload FROM {$wpdb->options} WHERE option_name LIKE %s", $like), ARRAY_A) as $row) {
                $kept_options[$row['option_name']] = ['option_value' => $row['option_value'], 'autoload' => $row['autoload']];
            }
        }
    }
    $cap_key = $prefix . 'capabilities';
    $admins = $wpdb->get_results($wpdb->prepare(
        "SELECT u.* FROM {$wpdb->users} u JOIN {$wpdb->usermeta} m ON m.user_id = u.ID WHERE m.meta_key = %s AND m.meta_value LIKE %s",
        $cap_key,
        '%' . $wpdb->esc_like('"administrator"') . '%'
    ), ARRAY_A);
    $admin_meta = [];
    $carry_meta = [$cap_key, $prefix . 'user_level', '_application_passwords', 'session_tokens'];
    foreach ((array) $admins as $admin) {
        foreach ($carry_meta as $key) {
            $value = $wpdb->get_var($wpdb->prepare("SELECT meta_value FROM {$wpdb->usermeta} WHERE user_id = %d AND meta_key = %s", $admin['ID'], $key));
            if ($value !== null) {
                $admin_meta[$admin['ID']][$key] = $value;
            }
        }
    }

    // One undo generation is kept. The previous one goes now, at the last
    // moment before a new one is made, so there is never a time with none.
    foreach (agentpress_push_tables($old_prefix) as $table) {
        mysqli_query($wpdb->dbh, "DROP TABLE IF EXISTS `$table`");
    }
    mysqli_query($wpdb->dbh, 'SET SESSION foreign_key_checks = 0');
    $live = agentpress_push_tables($prefix);
    $moves = [];
    foreach ($names as $name) {
        if (in_array($prefix . $name, $live, true)) {
            $moves[] = "`{$prefix}{$name}` TO `{$old_prefix}{$name}`";
        }
        $moves[] = "`{$new_prefix}{$name}` TO `{$prefix}{$name}`";
    }
    if (!mysqli_query($wpdb->dbh, 'RENAME TABLE ' . implode(', ', $moves))) {
        return agentpress_push_fail('swap_failed', 'Making the new database current failed, and nothing was changed: ' . mysqli_error($wpdb->dbh), 500);
    }
    wp_cache_flush();

    // From here the live tables are the copied ones.
    $put_option = function ($name, $value, $autoload) use ($wpdb) {
        $exists = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name = %s", $name));
        if ($exists) {
            $wpdb->update($wpdb->options, ['option_value' => $value], ['option_name' => $name]);
        } else {
            $wpdb->insert($wpdb->options, ['option_name' => $name, 'option_value' => $value, 'autoload' => $autoload]);
        }
    };
    foreach ($kept_options as $name => $row) {
        $put_option($name, $row['option_value'], $row['autoload']);
    }
    foreach ($own_options as $name => $row) {
        if ($row) {
            $put_option($name, $row['option_value'], $row['autoload']);
        } else {
            $wpdb->delete($wpdb->options, ['option_name' => $name]);
        }
    }
    // The copy's rows out first, then this site's back: a setting the copy
    // has and this site never had must not be left standing.
    foreach ($install_likes as $like) {
        $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name LIKE %s", $like));
    }
    foreach ($install_rows as $row) {
        $wpdb->insert($wpdb->options, $row);
    }
    // Plugins: the copy's own list, plus this plugin (or the job could not
    // finish itself), plus the few the caller names in `keep_plugin_dirs` when
    // they were active here - a pull uses that for the local agent wiring.
    // NOT "everything that was active here": the first version kept that
    // union, and a test target that had WooCommerce (which the source did
    // not) answered its next request 60 seconds late, because WooCommerce
    // found its options gone and ran its whole installer again.
    //
    // `drop_plugin_dirs` is the other direction: plugins the copy has switched
    // on that must NOT arrive switched on. A push names the local agent
    // plugins there (shell-exec and PHP-eval abilities), so a public server
    // never runs them just because the dev machine does. Dropped from the
    // copy's list first; a plugin this site was already running itself is
    // then put back by the keep rule, so only the SOURCE's choice is ignored.
    $keep_dirs = array_filter(array_map('strval', (array) ($args['keep_plugin_dirs'] ?? [])));
    $keep_dirs = array_merge($keep_dirs, array_keys(agentpress_push_page_cache_plugins()));
    $drop_dirs = array_filter(array_map('strval', (array) ($args['drop_plugin_dirs'] ?? [])));
    // Never maybe_unserialize() here: this value arrived in the copy, and a
    // plain unserialize builds whatever object the data names.
    $active_copy = @unserialize((string) $wpdb->get_var("SELECT option_value FROM {$wpdb->options} WHERE option_name = 'active_plugins'"), ['allowed_classes' => false]);
    $active_copy = is_array($active_copy) ? $active_copy : [];
    $active_copy = array_filter((array) $active_copy, function ($file) use ($drop_dirs) {
        return is_string($file) && !in_array(strtok($file, '/'), $drop_dirs, true);
    });
    $active = array_values(array_unique(array_merge((array) $active_copy, array_filter($active_here, function ($file) use ($keep_dirs) {
        return is_string($file) && in_array(strtok($file, '/'), $keep_dirs, true) && is_file(WP_PLUGIN_DIR . '/' . $file);
    }), [plugin_basename(__FILE__)])));
    sort($active);
    $put_option('active_plugins', serialize($active), 'yes');

    $kept_admins = [];
    $kept_ids = [];
    foreach ((array) $admins as $admin) {
        $old_id = (int) $admin['ID'];
        $new_id = (int) $wpdb->get_var($wpdb->prepare("SELECT ID FROM {$wpdb->users} WHERE user_login = %s", $admin['user_login']));
        if ($new_id) {
            $wpdb->update($wpdb->users, ['user_pass' => $admin['user_pass'], 'user_email' => $admin['user_email']], ['ID' => $new_id]);
        } else {
            $row = $admin;
            unset($row['ID']);
            $wpdb->insert($wpdb->users, $row);
            $new_id = (int) $wpdb->insert_id;
        }
        if (!$new_id) {
            continue;
        }
        foreach ($admin_meta[$old_id] ?? [] as $key => $value) {
            $wpdb->delete($wpdb->usermeta, ['user_id' => $new_id, 'meta_key' => $key]);
            $wpdb->insert($wpdb->usermeta, ['user_id' => $new_id, 'meta_key' => $key, 'meta_value' => $value]);
        }
        $kept_admins[] = $admin['user_login'];
        $kept_ids[] = $new_id;
    }
    // Logged-in sessions and application passwords never travel with a copy.
    // They are credentials minted on the OTHER machine: without this, the
    // app password a dev site hands its AI agent would also open the live
    // site's REST API for any user the copy brought along, and a browser
    // logged in to one site would be logged in to both. This site's own
    // administrators were put back above and are left alone.
    $not_kept = $kept_ids ? ' AND user_id NOT IN (' . implode(',', array_map('intval', $kept_ids)) . ')' : '';
    $wpdb->query("DELETE FROM {$wpdb->usermeta} WHERE meta_key IN ('_application_passwords', 'session_tokens')" . $not_kept);

    // A password does not travel to a live site either. The first real full
    // copy (2026-11-11) left the dev site's `admin` on the live server as an
    // administrator with its dev password - the one the site menu prints in
    // its header and .env holds in the clear - beside a REST API that lists
    // usernames to anyone. Every account the copy brought, and that is not
    // one of this site's own administrators (put back above with their own
    // password), gets a random one nobody knows. The account stays, so its
    // stories keep their author; its owner sets a password by email or an
    // administrator sets it. Asked for by the sender, and only a push asks:
    // a pull leaves the copied accounts as they came.
    $scrambled = [];
    if (!empty($args['scramble_arriving_passwords'])) {
        $where = $kept_ids ? ' WHERE ID NOT IN (' . implode(',', array_map('intval', $kept_ids)) . ')' : '';
        $scrambled = array_map('strval', (array) $wpdb->get_col("SELECT user_login FROM {$wpdb->users}" . $where));
        if ($scrambled) {
            // One statement for every account. The first version hashed a
            // random password per account, and a WordPress hash is slow on
            // purpose (222 ms each on PHP 8.4, measured): a few hundred
            // members and this single request outlived the host's gateway.
            // The value written is not the hash of ANY password - nothing
            // verifies against a string starting with "*" - so how random it
            // is does not matter; the random part only keeps rows different.
            $wpdb->query("UPDATE {$wpdb->users} SET user_pass = CONCAT('*', SHA2(CONCAT(RAND(), UUID(), ID), 256)), user_activation_key = ''" . $where);
        }
    }
    wp_cache_flush();
    agentpress_push_purge_page_cache();
    return ['swapped' => count($names), 'kept_options' => array_keys($kept_options), 'kept_admins' => $kept_admins, 'scrambled' => $scrambled, 'undo_available' => true];
}

/**
 * Undo the last swap: live and apold_ trade places. It is the same rename
 * run backwards, so an undo can itself be undone.
 */
function agentpress_push_op_db_undo()
{
    global $wpdb;
    $prefix = $wpdb->prefix;
    $old_prefix = AGENTPRESS_PUSH_OLD . $prefix;
    $tmp_prefix = AGENTPRESS_PUSH_TMP . $prefix;
    $old = agentpress_push_tables($old_prefix);
    if (!$old) {
        return agentpress_push_fail('no_undo', 'There is no earlier database kept on this site to go back to.', 404);
    }
    $live = agentpress_push_tables($prefix);
    $moves = [];
    foreach ($old as $table) {
        $name = substr($table, strlen($old_prefix));
        if (in_array($prefix . $name, $live, true)) {
            $moves[] = "`{$prefix}{$name}` TO `{$tmp_prefix}{$name}`";
            $moves[] = "`{$old_prefix}{$name}` TO `{$prefix}{$name}`";
            $moves[] = "`{$tmp_prefix}{$name}` TO `{$old_prefix}{$name}`";
        } else {
            $moves[] = "`{$old_prefix}{$name}` TO `{$prefix}{$name}`";
        }
    }
    mysqli_query($wpdb->dbh, 'SET SESSION foreign_key_checks = 0');
    if (!mysqli_query($wpdb->dbh, 'RENAME TABLE ' . implode(', ', $moves))) {
        return agentpress_push_fail('undo_failed', 'Going back failed, and nothing was changed: ' . mysqli_error($wpdb->dbh), 500);
    }
    wp_cache_flush();
    agentpress_push_purge_page_cache();
    return ['restored' => count($old)];
}

/* ------------------------------------------------------------------------
 * Files
 * --------------------------------------------------------------------- */

/**
 * Upload files that are WordPress's own leftovers, as a set of paths.
 *
 * "Upload Plugin" and "Upload Theme" save the zip as a media item marked
 * `upgrader` and delete it when the install ends, or two hours later if the
 * screen was left on "Replace current with uploaded?". Second day on the real
 * server (2026-11-12): the push plugin's own zip had been uploaded in the
 * LOCAL site's wp-admin, the screen was left, and the design push two minutes
 * later sent that zip to live as "media live does not have". It is nobody's
 * media, and on live nothing would ever have removed it.
 */
function agentpress_push_upgrader_leftovers()
{
    global $wpdb;
    $set = [];
    if (!isset($wpdb) || !is_object($wpdb)) {
        return $set;
    }
    $rows = $wpdb->get_col(
        "SELECT f.meta_value FROM {$wpdb->postmeta} c JOIN {$wpdb->postmeta} f ON f.post_id = c.post_id AND f.meta_key = '_wp_attached_file' "
        . "WHERE c.meta_key = '_wp_attachment_context' AND c.meta_value = 'upgrader'"
    );
    foreach ((array) $rows as $attached) {
        $set['uploads/' . ltrim(wp_normalize_path((string) $attached), '/')] = true;
    }
    return $set;
}

/**
 * Lists every file under the asked-for roots with its size and SHA-1, into
 * manifest.ndjson. Listing is one fast pass; hashing is the slow part and is
 * the part cut into steps.
 */
function agentpress_push_op_files_manifest($args)
{
    $dir = agentpress_push_session_dir($args['session'] ?? '');
    if (is_wp_error($dir)) {
        return $dir;
    }
    $state = is_array($args['state'] ?? null) ? $args['state'] : [];
    $state += ['listed' => false, 'i' => 0, 'count' => 0];
    $list = $dir . '/list.json';
    $path = $dir . '/manifest.ndjson';
    $roots = agentpress_push_roots();

    if (!$state['listed']) {
        $files = [];
        foreach ((array) ($args['roots'] ?? []) as $root) {
            if (!isset($roots[$root]) || !is_dir($roots[$root])) {
                continue;
            }
            $walker = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($roots[$root], FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
            $folders = [];
            $found = [];
            $leftovers = $root === 'uploads' ? agentpress_push_upgrader_leftovers() : [];
            foreach ($walker as $file) {
                if ($file->isLink()) {
                    continue;
                }
                $rel = $root . substr(wp_normalize_path($file->getPathname()), strlen($roots[$root]));
                if (agentpress_push_path_skipped($rel)) {
                    continue;
                }
                if ($file->isDir()) {
                    $folders[] = $rel . '/';
                } elseif ($file->isFile() && !isset($leftovers[$rel])) {
                    $found[] = $rel;
                }
            }
            // A folder with nothing in it travels as an entry of its own
            // (path ending in "/"). Files alone were listed at first, so empty
            // folders stayed behind - and Oxygen checks that three of its
            // upload folders EXIST: the first real push ended with wp-admin
            // saying "directories required for Oxygen ... are missing"
            // (design_sets, font_styles, fonts; 2026-11-11).
            sort($found);
            // Every folder that holds a file somewhere beneath it, marked by
            // walking up from each file once. (Asking each folder "does any
            // file start with you" was folders x files: fine on a new site,
            // minutes on a ten-year uploads folder.)
            $holds = [];
            foreach ($found as $rel) {
                for ($up = dirname($rel); $up !== '.' && $up !== '' && !isset($holds[$up]); $up = dirname($up)) {
                    $holds[$up] = true;
                }
            }
            foreach ($folders as $folder) {
                if (!isset($holds[rtrim($folder, '/')])) {
                    $files[] = $folder;
                }
            }
            $files = array_merge($files, $found);
        }
        sort($files);
        file_put_contents($list, wp_json_encode($files, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        file_put_contents($path, '');
        $state['listed'] = true;
        $state['count'] = count($files);
    }
    $files = json_decode((string) file_get_contents($list), true) ?: [];
    $out = fopen($path, 'ab');
    // hash=false: the caller only wants to know which paths exist (uploads in
    // a design push), so no file is opened at all.
    $hash = !isset($args['hash']) || !empty($args['hash']);
    $deadline = agentpress_push_deadline();
    while ($state['i'] < count($files) && microtime(true) < $deadline) {
        $rel = $files[$state['i']++];
        $abs = agentpress_push_resolve_path($rel);
        if (substr($rel, -1) === '/') {
            if (!is_wp_error($abs) && is_dir($abs)) {
                fwrite($out, wp_json_encode(['p' => $rel, 's' => 0, 'h' => 'dir'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
            }
            continue;
        }
        if (is_wp_error($abs) || !is_file($abs)) {
            continue; // deleted since it was listed
        }
        fwrite($out, wp_json_encode(['p' => $rel, 's' => filesize($abs), 'h' => $hash ? sha1_file($abs) : ''], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
    }
    fclose($out);
    return ['done' => $state['i'] >= count($files), 'state' => $state, 'files_done' => $state['i'], 'files' => $state['count']];
}

/**
 * Builds files.pack from the paths listed in want.ndjson (one JSON string
 * per line). The pack is a plain stream of records: a JSON header line
 * `{"p":path,"s":size}`, exactly `s` bytes, one newline. No zip, because
 * ZipArchive is an optional PHP extension and "optional" on shared hosting
 * means absent on the one host that matters.
 */
function agentpress_push_op_files_pack($args)
{
    $dir = agentpress_push_session_dir($args['session'] ?? '');
    if (is_wp_error($dir)) {
        return $dir;
    }
    $state = is_array($args['state'] ?? null) ? $args['state'] : [];
    $state += ['i' => 0, 'packed' => 0];
    $want = is_file($dir . '/want.ndjson') ? file($dir . '/want.ndjson', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : [];
    $out = fopen($dir . '/files.pack', $state['i'] === 0 ? 'wb' : 'ab');
    $deadline = agentpress_push_deadline();
    while ($state['i'] < count($want) && microtime(true) < $deadline) {
        $rel = json_decode($want[$state['i']++], true);
        $abs = is_string($rel) ? agentpress_push_resolve_path($rel) : null;
        if (!$abs || is_wp_error($abs) || agentpress_push_path_skipped($rel)) {
            continue;
        }
        if (substr($rel, -1) === '/') {
            // An empty folder: a header with no bytes after it.
            if (is_dir($abs)) {
                fwrite($out, wp_json_encode(['p' => $rel, 's' => 0, 'd' => 1], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n\n");
                $state['packed']++;
            }
            continue;
        }
        if (!is_file($abs)) {
            continue;
        }
        $in = fopen($abs, 'rb');
        if (!$in) {
            continue;
        }
        // Size is taken from what is actually copied, never from stat(): a
        // file that grows mid-read would otherwise desynchronise every record after it.
        $tmp = fopen('php://temp/maxmemory:8388608', 'w+b');
        $size = stream_copy_to_stream($in, $tmp);
        fclose($in);
        rewind($tmp);
        fwrite($out, wp_json_encode(['p' => $rel, 's' => $size], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n");
        stream_copy_to_stream($tmp, $out);
        fwrite($out, "\n");
        fclose($tmp);
        $state['packed']++;
    }
    fclose($out);
    clearstatcache(true, $dir . '/files.pack');
    return ['done' => $state['i'] >= count($want), 'state' => $state, 'files_done' => $state['i'], 'files' => count($want), 'bytes' => filesize($dir . '/files.pack')];
}

/**
 * Unpacks files.pack into place. Each file is written beside its destination
 * under a temporary name and renamed over it, so a request killed mid-write
 * leaves either the old file or the new one, never half of one.
 */
function agentpress_push_op_files_unpack($args)
{
    $dir = agentpress_push_session_dir($args['session'] ?? '');
    if (is_wp_error($dir)) {
        return $dir;
    }
    $path = $dir . '/files.pack';
    $in = is_file($path) ? fopen($path, 'rb') : false;
    if (!$in) {
        return agentpress_push_fail('unpack_missing', 'No file pack has been uploaded to this session.');
    }
    $state = is_array($args['state'] ?? null) ? $args['state'] : [];
    $state += ['pos' => 0, 'written' => 0, 'refused' => 0, 'refused_names' => []];
    // The pack was built by the OTHER site, so what it holds is a claim, not
    // a fact. The job says which roots it asked for and anything else is
    // refused outright: a pull asks for uploads only, and before this a pack
    // carrying `mu-plugins/x.php` was unpacked into the developer's site and
    // run by the very next step (security review, 2026-11-11; confirmed
    // against this file in a harness).
    $allowed = array_values(array_filter(array_map('strval', (array) ($args['roots'] ?? []))));
    if (!$allowed) {
        fclose($in);
        return agentpress_push_fail('unpack_roots', 'The file pack was sent without saying which folders it is for. Update AgentPress on the sending side.', 422);
    }
    $refuse_code = !empty($args['refuse_code']);
    $own = wp_normalize_path(__DIR__);
    $total = filesize($path);
    fseek($in, $state['pos']);
    $deadline = agentpress_push_deadline();
    while ($state['pos'] < $total && microtime(true) < $deadline) {
        $header = json_decode((string) fgets($in), true);
        if (!is_array($header) || !isset($header['p'], $header['s']) || (int) $header['s'] < 0) {
            fclose($in);
            return agentpress_push_fail('unpack_corrupt', 'The uploaded file pack is damaged. Files unpacked before this point are in place; run the push again.', 422);
        }
        $size = (int) $header['s'];
        $abs = agentpress_push_resolve_path($header['p']);
        if (is_wp_error($abs)) {
            fclose($in);
            return $abs;
        }
        if (!in_array(strtok((string) $header['p'], '/'), $allowed, true)) {
            fclose($in);
            return agentpress_push_fail('bad_root', 'The file pack holds ' . $header['p'] . ', which this job did not ask for. Nothing more was unpacked.', 422);
        }
        if (agentpress_push_path_skipped($header['p']) || agentpress_push_is_inside($abs, $own)) {
            // The second test is the first one again on the REAL path: the
            // name check alone let `plugins/AgentPress-Push/...` and
            // `plugins/AGENTP~1/...` overwrite the receiver on Windows.
            fseek($in, $size + 1, SEEK_CUR);
        } elseif ($refuse_code && strpos((string) $header['p'], 'uploads/') === 0 && agentpress_push_runs_as_code($header['p'])) {
            fseek($in, $size + 1, SEEK_CUR);
            $state['refused']++;
            if (count($state['refused_names']) < 10) {
                $state['refused_names'][] = (string) $header['p'];
            }
        } elseif (!empty($header['d']) || substr((string) $header['p'], -1) === '/') {
            // An empty folder the source has. Its own bytes are none.
            fseek($in, $size + 1, SEEK_CUR);
            if (!wp_mkdir_p(untrailingslashit($abs))) {
                fclose($in);
                return agentpress_push_fail('unpack_write', 'Could not create the folder ' . $header['p'] . '. Check folder permissions.', 507);
            }
            $state['written']++;
        } else {
            wp_mkdir_p(dirname($abs));
            $part = $abs . '.ap-part';
            $out = fopen($part, 'wb');
            if (!$out) {
                fclose($in);
                return agentpress_push_fail('unpack_write', 'Could not write ' . $header['p'] . '. Check folder permissions and disk space.', 507);
            }
            $copied = $size > 0 ? stream_copy_to_stream($in, $out, $size) : 0;
            fclose($out);
            if ($copied !== $size) {
                @unlink($part);
                fclose($in);
                return agentpress_push_fail('unpack_short', 'The file pack ended in the middle of ' . $header['p'] . '. Run the push again.', 422);
            }
            fgetc($in); // the newline that closes the record
            if (!@rename($part, $abs)) {
                @unlink($abs);
                if (!@rename($part, $abs)) {
                    @unlink($part);
                    fclose($in);
                    return agentpress_push_fail('unpack_place', 'Could not put ' . $header['p'] . ' in place (the existing file may be locked or read-only).', 507);
                }
            }
            if (function_exists('opcache_invalidate') && substr($abs, -4) === '.php') {
                @opcache_invalidate($abs, true);
            }
            $state['written']++;
        }
        $state['pos'] = ftell($in);
    }
    fclose($in);
    return ['done' => $state['pos'] >= $total, 'state' => $state, 'written' => $state['written'], 'refused' => $state['refused'], 'refused_names' => $state['refused_names'], 'bytes_done' => $state['pos'], 'bytes' => $total];
}

/* ------------------------------------------------------------------------
 * Design (Oxygen)
 * --------------------------------------------------------------------- */

function agentpress_push_design_meta_keys()
{
    $prefix = \Breakdance\BreakdanceOxygen\Strings\__bdox('_meta_prefix');
    // The third key is what Oxygen's own Design Library import leaves behind
    // (live-verified 2026-11-11: all ten blocks of a real site arrived without it).
    return [$prefix . 'data', $prefix . 'template_settings', '_breakdance_block_settings'];
}

function agentpress_push_design_types()
{
    // Blocks first: anything else can point at a block by post id.
    return [BREAKDANCE_BLOCK_POST_TYPE, BREAKDANCE_HEADER_POST_TYPE, BREAKDANCE_FOOTER_POST_TYPE, BREAKDANCE_TEMPLATE_POST_TYPE];
}

/**
 * Everything that is "the design": Oxygen blocks, header, footer, templates,
 * pages built in Oxygen, and the site-wide selectors, variables and global
 * settings. Stories, users, comments and media are not in it and cannot be
 * touched by anything that consumes it.
 *
 * `$mint` gives each item a permanent id (a UUID in post meta) the first time
 * it is exported. Post ids cannot be the identity: templates and stories
 * share one counter, so a template made locally after launch gets the same
 * number as a story written on live. (Seen on the first real test: live
 * story 63, local template 63.)
 */
function agentpress_push_design_bundle($mint)
{
    $keys = agentpress_push_design_meta_keys();
    $data_key = $keys[0];
    $posts = [];
    foreach (agentpress_push_design_types() as $type) {
        $ids = get_posts(['post_type' => $type, 'posts_per_page' => -1, 'post_status' => 'publish', 'fields' => 'ids', 'orderby' => 'ID', 'order' => 'ASC', 'suppress_filters' => true]);
        if (function_exists('\Breakdance\DesignLibrary\removeFallbacksFromTemplateIdsList')) {
            $ids = \Breakdance\DesignLibrary\removeFallbacksFromTemplateIdsList($ids);
        }
        foreach ($ids as $id) {
            $posts[] = get_post($id);
        }
    }
    $pages = get_posts(['post_type' => 'page', 'posts_per_page' => -1, 'post_status' => 'publish', 'orderby' => 'ID', 'order' => 'ASC', 'suppress_filters' => true,
        'meta_query' => [['key' => $data_key, 'compare' => 'EXISTS']]]);
    $items = [];
    foreach (array_merge($posts, $pages) as $post) {
        if (!$post) {
            continue;
        }
        $uid = (string) get_post_meta($post->ID, AGENTPRESS_PUSH_UID, true);
        if ($uid === '' && $mint) {
            $uid = wp_generate_uuid4();
            update_post_meta($post->ID, AGENTPRESS_PUSH_UID, $uid);
        }
        $meta = [];
        foreach ($keys as $key) {
            if (metadata_exists('post', $post->ID, $key)) {
                $meta[$key] = \Breakdance\Data\get_meta($post->ID, $key);
            }
        }
        $items[] = [
            'uid' => $uid,
            'source_id' => (int) $post->ID,
            'post_type' => $post->post_type,
            'post_title' => $post->post_title,
            'post_name' => $post->post_name,
            'post_content' => $post->post_content,
            'post_excerpt' => $post->post_excerpt,
            'menu_order' => (int) $post->menu_order,
            'meta' => $meta,
        ];
    }
    return [
        'format' => AGENTPRESS_PUSH_FORMAT,
        'source_url' => site_url(),
        'oxygen_version' => agentpress_push_oxygen_version(),
        'items' => $items,
        'selectors' => [
            'selectors' => \Breakdance\BreakdanceOxygen\Selectors\getOxySelectors(),
            'collections' => \Breakdance\BreakdanceOxygen\Selectors\getOxySelectorsCollections(),
        ],
        'variables' => [
            'variables' => \Breakdance\Variables\getVariables(),
            'collections' => \Breakdance\Variables\getVariablesCollections(),
        ],
        'global_settings' => \Breakdance\Data\get_global_settings_array(),
        'page_on_front' => get_option('show_on_front') === 'page' ? (int) get_option('page_on_front') : 0,
    ];
}

/**
 * A fingerprint of the design that is the same on two sites holding the same
 * design: post ids and the site's own address are taken out first, because
 * both legitimately differ between a local site and its live copy.
 */
function agentpress_push_design_hash($bundle)
{
    $ids = [];
    foreach ($bundle['items'] as $item) {
        // Type and slug, not the permanent id: a site filled by a full copy
        // made before any id was minted holds the same design with no ids yet,
        // and must still compare as the same.
        $ids[(int) $item['source_id']] = $item['post_type'] . '/' . $item['post_name'];
    }
    $front = $bundle['page_on_front'] && isset($ids[$bundle['page_on_front']]) ? $ids[$bundle['page_on_front']] : '';
    $parts = [];
    foreach ($bundle['items'] as $item) {
        // Block references are rewritten on the tree string ITSELF, before it
        // is encoded. Encoded, every quote inside it is escaped (\"block\":140)
        // and the reference pattern matches nothing - which is how the first
        // version reported "the design differs" straight after a push that
        // had just made the two sites identical (live-verified 2026-11-11).
        $meta = $item['meta'];
        foreach ($meta as $key => $value) {
            if (is_array($value) && isset($value['tree_json_string']) && is_string($value['tree_json_string'])) {
                $meta[$key]['tree_json_string'] = preg_replace_callback(agentpress_push_ref_regex(), function ($m) use ($ids) {
                    return '"' . $m[1] . '":"' . ($ids[(int) $m[2]] ?? $m[2]) . '"';
                }, $value['tree_json_string']);
            }
        }
        $meta = strtr(wp_json_encode($meta), agentpress_push_url_pairs([$bundle['source_url']], 'https://site.invalid'));
        $parts[] = [$ids[(int) $item['source_id']], $item['post_type'], $item['post_title'], $item['post_name'], $item['post_content'], $meta];
    }
    sort($parts);
    return sha1(wp_json_encode([$parts, $bundle['selectors'], $bundle['variables'], $bundle['global_settings'], $front]));
}

/** Properties whose integer value is the post id of a block. Oxygen's own list when it is loaded. */
function agentpress_push_ref_regex()
{
    if (function_exists('\Breakdance\DesignLibrary\blockReferenceRegex')) {
        return \Breakdance\DesignLibrary\blockReferenceRegex();
    }
    return '/"(block|global_block|componentId|when_empty|after_title_bar|after_footer)":\s*(\d+)(?!\d)/';
}

function agentpress_push_op_design_export()
{
    if (!agentpress_push_oxygen_ready()) {
        return agentpress_push_fail('no_oxygen', 'Oxygen is not active on this site, so there is no design to export.', 409);
    }
    $bundle = agentpress_push_design_bundle(true);
    $bundle['hash'] = agentpress_push_design_hash($bundle);
    return $bundle;
}

/**
 * Applies a design bundle IN PLACE. Each item lands on the post that already
 * carries its permanent id; failing that on the one published post of the
 * same type and slug that has no id yet (a site first filled by some other
 * route); failing that on a new post. An item this site holds that the
 * bundle no longer has goes to the bin, where WordPress keeps it 30 days.
 * A post with no permanent id is never removed: it was not made by a push.
 *
 * Why not Oxygen's own "import a site from a Design Library": run twice
 * against a test site on 2026-11-11 it kept the editor's stories, but it
 * bins and recreates every template under a new post id on each run, adds a
 * second published "Home" page (slug home-2) whenever the page changed, and
 * drops every block's settings. Fine for a one-off starter site, wrong for
 * the tenth push to a site someone is writing on.
 */
function agentpress_push_op_design_apply($args)
{
    if (!agentpress_push_oxygen_ready()) {
        return agentpress_push_fail('no_oxygen', 'Oxygen is not active on this site, so a design cannot be applied to it.', 409);
    }
    $dry = !empty($args['dry']);
    if (isset($args['bundle']) && is_array($args['bundle'])) {
        $bundle = $args['bundle'];
    } else {
        $dir = agentpress_push_session_dir($args['session'] ?? '');
        if (is_wp_error($dir)) {
            return $dir;
        }
        $bundle = json_decode((string) @file_get_contents($dir . '/design.json'), true);
    }
    if (!is_array($bundle) || (int) ($bundle['format'] ?? 0) !== AGENTPRESS_PUSH_FORMAT || !isset($bundle['items'], $bundle['selectors'], $bundle['variables'])) {
        return agentpress_push_fail('bad_bundle', 'The design bundle is missing or was made by a different version of AgentPress Push.', 422);
    }
    // The bundle is Oxygen's internal data, and its shape is Oxygen's to
    // change between releases. Same version on both ends, or no push.
    $here = agentpress_push_oxygen_version();
    if (empty($args['allow_version_mismatch']) && (string) ($bundle['oxygen_version'] ?? '') !== (string) $here) {
        return agentpress_push_fail('oxygen_mismatch', sprintf('Oxygen is %s on the source and %s here. Update both to the same version, then push again.', $bundle['oxygen_version'] ?? 'unknown', $here ?? 'missing'), 409);
    }
    foreach ($bundle['items'] as $item) {
        if (empty($item['uid'])) {
            return agentpress_push_fail('bad_bundle', 'A design item has no permanent id. Export the design again with the current plugin.', 422);
        }
    }

    $keys = agentpress_push_design_meta_keys();
    $data_key = $keys[0];
    $types = array_merge(agentpress_push_design_types(), ['page']);
    $alive = ['publish', 'draft', 'pending', 'private', 'future'];

    // 1. Where does each item land?
    $plan = [];
    $claimed = [];
    // Pass one: permanent ids. These are certain, so they claim first.
    foreach ($bundle['items'] as $i => $item) {
        if (!in_array($item['post_type'], $types, true)) {
            return agentpress_push_fail('bad_bundle', 'The bundle holds a post type that is not design: ' . $item['post_type'], 422);
        }
        $found = get_posts(['post_type' => $item['post_type'], 'post_status' => $alive, 'posts_per_page' => 1, 'fields' => 'ids', 'meta_key' => AGENTPRESS_PUSH_UID, 'meta_value' => $item['uid'], 'suppress_filters' => true]);
        $plan[$i] = ['action' => 'update', 'target' => $found ? (int) $found[0] : 0];
        if (!$found) {
            // In the bin with this very id: an earlier push removed it and this
            // one (an undo, usually) wants it back. Take it out of the bin
            // rather than build a twin, so its post id stays what it was.
            $binned = get_posts(['post_type' => $item['post_type'], 'post_status' => 'trash', 'posts_per_page' => 1, 'fields' => 'ids', 'orderby' => 'ID', 'order' => 'DESC', 'meta_key' => AGENTPRESS_PUSH_UID, 'meta_value' => $item['uid'], 'suppress_filters' => true]);
            if ($binned) {
                $plan[$i] = ['action' => 'restore', 'target' => (int) $binned[0]];
                $found = $binned;
            }
        }
        if ($found) {
            $claimed[(int) $found[0]] = true;
        }
    }
    // Pass two: the one published post of the same type and slug that no
    // other item has claimed - whether or not it carries some OTHER id. A
    // second machine that has not pulled yet mints its own ids for the same
    // design; matching it by slug re-stamps the existing template instead of
    // making a twin and binning the original.
    foreach ($bundle['items'] as $i => $item) {
        if ($plan[$i]['target']) {
            continue;
        }
        $query = ['post_type' => $item['post_type'], 'post_status' => 'publish', 'posts_per_page' => 5, 'fields' => 'ids', 'suppress_filters' => true];
        $query[$item['post_type'] === 'page' ? 'name' : 'title'] = $item['post_type'] === 'page' ? $item['post_name'] : $item['post_title'];
        $candidates = array_values(array_filter(array_map('intval', get_posts($query)), function ($id) use ($claimed) {
            return !isset($claimed[$id]);
        }));
        // Two candidates is not a match, it is a guess. Create instead.
        $target = count($candidates) === 1 ? $candidates[0] : 0;
        if ($target) {
            $claimed[$target] = true;
        }
        $plan[$i] = ['action' => $target ? 'adopt' : 'create', 'target' => $target];
    }
    $orphans = [];
    foreach (get_posts(['post_type' => $types, 'post_status' => $alive, 'posts_per_page' => -1, 'meta_key' => AGENTPRESS_PUSH_UID, 'suppress_filters' => true]) as $post) {
        if (!isset($claimed[(int) $post->ID])) {
            $orphans[] = $post;
        }
    }

    // 2. Before anything is written, keep what is here now. This is the undo.
    $backup = null;
    if (!$dry) {
        $before = agentpress_push_design_bundle(true);
        $backup_dir = agentpress_push_data_dir() . '/design-backups';
        wp_mkdir_p($backup_dir);
        if (!file_exists($backup_dir . '/index.php')) {
            @file_put_contents($backup_dir . '/index.php', "<?php\n// Silence is golden.\n");
        }
        // 128 random bits, like a session folder: on a server that ignores
        // .htaccess the name is the only thing between this file and a guess,
        // and a timestamp plus 24 bits was not that. The timestamp stays in
        // front because the newest backup is found by sorting the names.
        $backup = 'design-' . gmdate('Ymd-His') . '-' . bin2hex(random_bytes(16)) . '.json';
        if (@file_put_contents($backup_dir . '/' . $backup, wp_json_encode($before, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) === false) {
            return agentpress_push_fail('backup_failed', 'Could not save a backup of the current design, so nothing was changed.', 507);
        }
        $kept = glob($backup_dir . '/design-*.json') ?: [];
        sort($kept);
        foreach (array_slice($kept, 0, max(0, count($kept) - 10)) as $old) {
            @unlink($old);
        }
    }

    // 3. Make the missing posts first, so every reference has somewhere to point.
    if (!$dry) {
        foreach ($bundle['items'] as $i => $item) {
            if ($plan[$i]['action'] === 'create') {
                $id = wp_insert_post(wp_slash([
                    'post_type' => $item['post_type'], 'post_status' => 'publish', 'post_title' => $item['post_title'],
                    'post_name' => $item['post_name'], 'post_content' => $item['post_content'], 'post_excerpt' => $item['post_excerpt'],
                    'menu_order' => (int) $item['menu_order'],
                ]), true);
                if (is_wp_error($id)) {
                    return agentpress_push_fail('create_failed', 'Could not create "' . $item['post_title'] . '": ' . $id->get_error_message(), 500);
                }
                $plan[$i]['target'] = (int) $id;
            }
            if ($plan[$i]['action'] === 'restore') {
                // Untrashing lands a post as a draft since WordPress 5.6, so publish it explicitly.
                wp_untrash_post($plan[$i]['target']);
                wp_update_post(['ID' => $plan[$i]['target'], 'post_status' => 'publish']);
            }
            if ($plan[$i]['action'] !== 'update') {
                update_post_meta($plan[$i]['target'], AGENTPRESS_PUSH_UID, $item['uid']);
            }
        }
    }
    $map = [];
    foreach ($bundle['items'] as $i => $item) {
        if ($plan[$i]['target']) {
            $map[(int) $item['source_id']] = (int) $plan[$i]['target'];
        }
    }
    // Every URL, media included. Oxygen's own helper deliberately skips
    // /wp-content/ because its importer does not bring media; a push does.
    $pairs = agentpress_push_url_pairs([$bundle['source_url']], site_url());

    // 4. Write each item.
    $changes = [];
    foreach ($bundle['items'] as $i => $item) {
        $target = $plan[$i]['target'];
        $changed = [];
        foreach ((array) $item['meta'] as $key => $value) {
            if (!in_array($key, $keys, true)) {
                continue;
            }
            if ($key === $data_key && is_array($value) && isset($value['tree_json_string'])) {
                $tree = strtr((string) $value['tree_json_string'], $pairs);
                $value['tree_json_string'] = preg_replace_callback(agentpress_push_ref_regex(), function ($m) use ($map) {
                    return '"' . $m[1] . '":' . (isset($map[(int) $m[2]]) ? $map[(int) $m[2]] : $m[2]);
                }, $tree);
            }
            if (!$target || \Breakdance\Data\get_meta($target, $key) !== $value) {
                $changed[] = $key;
                if (!$dry) {
                    \Breakdance\Data\set_meta($target, $key, $value);
                }
            }
        }
        if ($target) {
            $post = get_post($target);
            $fields = [];
            foreach (['post_title', 'post_name', 'post_content', 'post_excerpt'] as $field) {
                if ($post && $post->$field !== $item[$field]) {
                    $fields[$field] = $item[$field];
                }
            }
            if ($fields) {
                $changed[] = implode('+', array_keys($fields));
                if (!$dry) {
                    wp_update_post(wp_slash(array_merge(['ID' => $target], $fields)));
                }
            }
        }
        $verb = $plan[$i]['action'] === 'update' && !$changed ? 'same' : $plan[$i]['action'];
        $changes[] = ['action' => $verb, 'type' => $item['post_type'], 'title' => $item['post_title'], 'id' => $target ?: null, 'changed' => $changed];
    }
    foreach ($orphans as $post) {
        $changes[] = ['action' => 'bin', 'type' => $post->post_type, 'title' => $post->post_title, 'id' => (int) $post->ID, 'changed' => []];
        if (!$dry) {
            wp_trash_post($post->ID);
        }
    }

    // 5. Site-wide design data, through Oxygen's own savers so its revisions
    //    and caches behave. Selectors are replaced as one list, ids and all:
    //    elements bind to a selector by id, so a selector that arrived under a
    //    new id would leave every element using it with no class at all.
    $site = [
        'selectors' => \Breakdance\BreakdanceOxygen\Selectors\getOxySelectors() === $bundle['selectors']['selectors'] ? 'same' : 'update',
        'variables' => \Breakdance\Variables\getVariables() === $bundle['variables']['variables'] ? 'same' : 'update',
        'global_settings' => \Breakdance\Data\get_global_settings_array() === $bundle['global_settings'] ? 'same' : 'update',
    ];
    $front = !empty($bundle['page_on_front']) && isset($map[(int) $bundle['page_on_front']]) ? $map[(int) $bundle['page_on_front']] : 0;
    $site['front_page'] = empty($bundle['page_on_front']) ? 'none' : ($front && (int) get_option('page_on_front') === $front && get_option('show_on_front') === 'page' ? 'same' : 'update');
    if (!$dry) {
        if ($site['selectors'] === 'update') {
            \Breakdance\BreakdanceOxygen\Selectors\saveSelectors(wp_json_encode($bundle['selectors']));
        }
        if ($site['variables'] === 'update') {
            \Breakdance\Variables\saveVariables(wp_json_encode($bundle['variables']));
        }
        if ($site['global_settings'] === 'update' && function_exists('\Breakdance\Data\save_global_settings')) {
            \Breakdance\Data\save_global_settings(wp_json_encode($bundle['global_settings']));
        }
        if ($site['front_page'] === 'update' && $front) {
            update_option('show_on_front', 'page');
            update_option('page_on_front', $front);
        }
    }
    $counts = array_count_values(array_column($changes, 'action'));
    return ['dry' => $dry, 'changes' => $changes, 'counts' => $counts, 'site' => $site, 'backup' => $backup];
}

/** Puts back the design saved by the most recent design_apply. */
function agentpress_push_op_design_undo($args)
{
    $kept = glob(agentpress_push_data_dir() . '/design-backups/design-*.json') ?: [];
    sort($kept);
    $file = end($kept);
    if (!$file) {
        return agentpress_push_fail('no_undo', 'There is no saved design on this site to go back to.', 404);
    }
    $bundle = json_decode((string) file_get_contents($file), true);
    $result = agentpress_push_op_design_apply(['bundle' => $bundle, 'dry' => !empty($args['dry']), 'allow_version_mismatch' => true]);
    if (!is_wp_error($result)) {
        $result['restored_from'] = basename($file);
    }
    return $result;
}

/* ------------------------------------------------------------------------
 * Stories: posts written on the dev site, sent up one at a time
 *
 * Content is the live site's and comes down in a pull. This is the one way
 * UP for it, and it exists for a single case: stories written on the dev
 * site, which is the only place the AI agent works. Before this they had
 * nowhere to go: a design push ignores them, a full copy would send them by
 * replacing everything the editor wrote, and the next pull deleted them.
 *
 * A story is not copied, it is created again: its author, categories and
 * images are different rows with different numbers on the other site. And
 * it is only ever ADDED. A story the live site already has is the editor's,
 * and is never overwritten, with one exception: one this tool sent that
 * nobody has touched there since.
 *
 * Which stories does live "already have"? Not a question a title or a slug
 * can answer (the editor renames, reschedules and deletes), so the DEV site
 * keeps a note on each story: `live` when it came down in a pull or went up
 * in a full copy, a fingerprint when this tool sent it. A story with no note
 * was written here. Same lesson as the uploads ledger: "live does not have
 * it" is two facts, and only a note taken at the time tells them apart.
 * --------------------------------------------------------------------- */

function agentpress_push_story_statuses()
{
    return ['publish', 'draft', 'pending', 'future', 'private'];
}

/** Every story on this site, as little of each as it takes to recognise it. Reads only. */
function agentpress_push_op_stories_index()
{
    global $wpdb;
    $rows = $wpdb->get_results("SELECT ID, post_date_gmt, post_title FROM {$wpdb->posts} WHERE post_type = 'post' AND post_status <> 'auto-draft' ORDER BY ID ASC", ARRAY_A);
    $stories = [];
    foreach ((array) $rows as $row) {
        $stories[] = ['id' => (int) $row['ID'], 'date_gmt' => (string) $row['post_date_gmt'], 'title' => (string) $row['post_title']];
    }
    return ['stories' => $stories];
}

/** The live site's stories_index, keyed by post number. */
function agentpress_push_story_live_map($index)
{
    $live = [];
    foreach ((array) $index as $row) {
        if (is_array($row) && isset($row['id'])) {
            $live[(int) $row['id']] = $row;
        }
    }
    return $live;
}

/**
 * Is this story the same ROW as one on the live site? Same number and same
 * publish time: the two databases were one database at the last pull or full
 * copy, and both count upwards from there, so a story written here since and
 * one written there since can share a number but not the second they were
 * published. A draft has no publish time, so there it is number and title.
 */
function agentpress_push_story_same_row($id, $date_gmt, $title, $live)
{
    $theirs = $live[(int) $id] ?? null;
    if (!$theirs) {
        return false;
    }
    $none = '0000-00-00 00:00:00';
    $their_date = (string) ($theirs['date_gmt'] ?? $none);
    if ((string) $date_gmt !== $none && $their_date !== $none) {
        return (string) $date_gmt === $their_date;
    }
    return (string) $title === (string) ($theirs['title'] ?? '');
}

/**
 * Writes down, on the dev site, which of its stories the live site has.
 *
 * Without `index`: all of them. That is the state straight after a pull or a
 * full copy, when the two databases are the same rows.
 *
 * With `index` (the live site's stories_index): the ones that are the same
 * row on both. That is how a site connected before this existed gets its
 * notes without a pull, which would delete the very stories waiting to go
 * up. A story that matches nothing stays "written here", and the receiver
 * has a second check (same address) before it makes anything.
 */
function agentpress_push_op_stories_level($args)
{
    global $wpdb;
    $mark = (string) ($args['mark'] ?? '');
    if (!preg_match('/^[A-Za-z0-9.:-]+$/', $mark)) {
        return agentpress_push_fail('bad_mark', 'No live site was named to level the stories with.', 422);
    }
    $key = AGENTPRESS_PUSH_STORY_SENT;
    $index = isset($args['index']) && is_array($args['index']) ? $args['index'] : null;
    // Notes taken against another live site say nothing about this one.
    $stale = !empty($args['reset']) || (string) get_option(AGENTPRESS_PUSH_STORIES_SYNCED, '') !== $mark;
    $clear = "DELETE m FROM {$wpdb->postmeta} m JOIN {$wpdb->posts} p ON p.ID = m.post_id WHERE m.meta_key = %s AND p.post_type = 'post'";
    $noted = 0;
    if ($index === null) {
        $wpdb->query($wpdb->prepare($clear, $key));
        $noted = (int) $wpdb->query($wpdb->prepare("INSERT INTO {$wpdb->postmeta} (post_id, meta_key, meta_value) SELECT ID, %s, 'live' FROM {$wpdb->posts} WHERE post_type = 'post' AND post_status <> 'auto-draft'", $key));
    } else {
        $live = agentpress_push_story_live_map($index);
        if ($stale) {
            $wpdb->query($wpdb->prepare($clear, $key));
        }
        $rows = $wpdb->get_results($wpdb->prepare(
            "SELECT p.ID, p.post_date_gmt, p.post_title FROM {$wpdb->posts} p
             LEFT JOIN {$wpdb->postmeta} m ON m.post_id = p.ID AND m.meta_key = %s
             WHERE p.post_type = 'post' AND p.post_status <> 'auto-draft' AND m.meta_id IS NULL ORDER BY p.ID ASC",
            $key
        ), ARRAY_A);
        foreach ((array) $rows as $row) {
            if (agentpress_push_story_same_row($row['ID'], $row['post_date_gmt'], $row['post_title'], $live)) {
                add_post_meta((int) $row['ID'], $key, 'live', true);
                $noted++;
            }
        }
    }
    update_option(AGENTPRESS_PUSH_STORIES_SYNCED, $mark, false);
    wp_cache_flush();
    return ['noted' => $noted, 'unsent' => agentpress_push_stories_unsent(), 'synced_with' => $mark];
}

/** How many stories on this site carry no note, so were written here and never sent. */
function agentpress_push_stories_unsent()
{
    global $wpdb;
    $in = "'" . implode("','", agentpress_push_story_statuses()) . "'";
    return (int) $wpdb->get_var($wpdb->prepare(
        "SELECT COUNT(*) FROM {$wpdb->posts} p LEFT JOIN {$wpdb->postmeta} m ON m.post_id = p.ID AND m.meta_key = %s
         WHERE p.post_type = 'post' AND p.post_status IN ($in) AND m.meta_id IS NULL AND NOT (p.ID = 1 AND p.post_name = 'hello-world')",
        AGENTPRESS_PUSH_STORY_SENT
    ));
}

/** The "Hello world!" every new WordPress starts with: post 1, at that address. */
function agentpress_push_story_is_sample($id, $slug)
{
    return (int) $id === 1 && (string) $slug === 'hello-world';
}

/**
 * The permanent id a story written here goes up under, and is found again
 * by. Worked out, not stored, until the live site confirms it has the story.
 * Asked again after a send that failed halfway it gives the same answer, so
 * the story is found there instead of being made twice.
 */
function agentpress_push_story_uid($post)
{
    $h = sha1(site_url() . '|' . $post->ID . '|' . $post->post_date . '|' . $post->post_type);
    return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20, 12);
}

/** The blocks whose `id` is a media-library number. Any other block's `id` is its own business. */
function agentpress_push_story_media_blocks()
{
    return '(?:core\/)?(?:image|cover|media-text|file|video|audio|gallery)';
}

/** Every media-library number a story's text points at, by the places WordPress writes one. */
function agentpress_push_story_media_ids($content)
{
    $ids = [];
    foreach (['/\bwp-image-(\d+)\b/', '/\bdata-id="(\d+)"/', '/\battachment_(\d+)\b/'] as $pattern) {
        if (preg_match_all($pattern, $content, $m)) {
            $ids = array_merge($ids, $m[1]);
        }
    }
    if (preg_match_all('/<!--\s+wp:' . agentpress_push_story_media_blocks() . '\s+(\{.*?\})\s+\/?-->/s', $content, $m)) {
        foreach ($m[1] as $json) {
            if (preg_match_all('/"(?:id|mediaId)":(\d+)/', $json, $n)) {
                $ids = array_merge($ids, $n[1]);
            }
            if (preg_match_all('/"ids":\[([\d,\s]*)\]/', $json, $n)) {
                foreach ($n[1] as $list) {
                    $ids = array_merge($ids, preg_split('/[\s,]+/', $list, -1, PREG_SPLIT_NO_EMPTY));
                }
            }
        }
    }
    if (preg_match_all('/\[gallery\b[^\]]*\bids="([\d,\s]+)"/', $content, $m)) {
        foreach ($m[1] as $list) {
            $ids = array_merge($ids, preg_split('/[\s,]+/', $list, -1, PREG_SPLIT_NO_EMPTY));
        }
    }
    return array_values(array_unique(array_filter(array_map('intval', $ids))));
}

/** The same places, with each number swapped for the one the image has on this site. */
function agentpress_push_story_rewrite_ids($content, $map)
{
    if (!$map) {
        return $content;
    }
    $swap = function ($id) use ($map) {
        $id = (int) $id;
        return isset($map[$id]) ? (int) $map[$id] : $id;
    };
    $list = function ($text) use ($swap) {
        return implode(',', array_map($swap, preg_split('/[\s,]+/', $text, -1, PREG_SPLIT_NO_EMPTY)));
    };
    $content = preg_replace_callback('/\bwp-image-(\d+)\b/', function ($m) use ($swap) { return 'wp-image-' . $swap($m[1]); }, $content);
    $content = preg_replace_callback('/\bdata-id="(\d+)"/', function ($m) use ($swap) { return 'data-id="' . $swap($m[1]) . '"'; }, $content);
    $content = preg_replace_callback('/\battachment_(\d+)\b/', function ($m) use ($swap) { return 'attachment_' . $swap($m[1]); }, $content);
    $content = preg_replace_callback('/(<!--\s+wp:' . agentpress_push_story_media_blocks() . '\s+)(\{.*?\})(\s+\/?-->)/s', function ($m) use ($swap, $list) {
        $json = preg_replace_callback('/"(id|mediaId)":(\d+)/', function ($n) use ($swap) { return '"' . $n[1] . '":' . $swap($n[2]); }, $m[2]);
        $json = preg_replace_callback('/"ids":\[([\d,\s]*)\]/', function ($n) use ($list) { return '"ids":[' . $list($n[1]) . ']'; }, $json);
        return $m[1] . $json . $m[3];
    }, $content);
    $content = preg_replace_callback('/(\[gallery\b[^\]]*\bids=")([\d,\s]+)(")/', function ($m) use ($list) { return $m[1] . $list($m[2]) . $m[3]; }, $content);
    return $content;
}

/** One media-library item as the other site needs it to make its own: the file, every size of it, and what was typed about it. */
function agentpress_push_story_media_record($id)
{
    $post = get_post($id);
    $rel = $post && $post->post_type === 'attachment' ? (string) get_post_meta($id, '_wp_attached_file', true) : '';
    $base = agentpress_push_roots()['uploads'] ?? '';
    if ($rel === '' || $base === '' || !is_file($base . '/' . $rel)) {
        return null;
    }
    $meta = wp_get_attachment_metadata($id, true);
    $dir = dirname($rel) === '.' ? '' : dirname($rel) . '/';
    $files = [$rel];
    if (is_array($meta)) {
        foreach ((array) ($meta['sizes'] ?? []) as $size) {
            if (!empty($size['file'])) {
                $files[] = $dir . $size['file'];
            }
        }
        if (!empty($meta['original_image'])) {
            $files[] = $dir . $meta['original_image'];
        }
    }
    $files = array_values(array_unique(array_filter($files, function ($file) use ($base) { return is_file($base . '/' . $file); })));
    return [
        'id' => (int) $id,
        'file' => $rel,
        'size' => (int) filesize($base . '/' . $rel),
        'files' => $files,
        'mime' => (string) $post->post_mime_type,
        'title' => (string) $post->post_title,
        'caption' => (string) $post->post_excerpt,
        'description' => (string) $post->post_content,
        'alt' => (string) get_post_meta($id, '_wp_attachment_image_alt', true),
        'date' => (string) $post->post_date,
        'meta' => is_array($meta) ? $meta : null,
    ];
}

/** Meta that is this install's bookkeeping, or another feature's to carry, and so stays behind. */
function agentpress_push_story_meta_skipped($key)
{
    if (in_array($key, ['_edit_lock', '_edit_last', '_thumbnail_id', '_wp_old_slug', '_wp_old_date', '_wp_desired_post_slug', '_pingme', '_encloseme'], true)) {
        return true;
    }
    foreach (['_agentpress_', '_wp_trash_', '_oxygen_', '_breakdance_'] as $prefix) {
        if (strpos($key, $prefix) === 0) {
            return true;
        }
    }
    return false;
}

/**
 * The stories on this site that could go up: the ones written here, and the
 * ones already sent that were changed here since. One that came from the
 * live site is not in the list at all, changed here or not: that one is the
 * editor's. `only` narrows it to the ids or slugs asked for, and brings in a
 * sent story even when it has not changed (to send it again as a draft, say).
 *
 * `index` + `mark` are for a site whose notes were never taken against this
 * live site (see stories_level): the answer is worked out as if they had
 * been, and nothing is written. A dry run and a pull's warning ask this way.
 */
function agentpress_push_op_stories_export($args)
{
    global $wpdb;
    $only = array_values(array_filter(array_map('strval', (array) ($args['only'] ?? [])), 'strlen'));
    $live = isset($args['index']) && is_array($args['index']) ? agentpress_push_story_live_map($args['index']) : null;
    $stale = $live !== null && (string) get_option(AGENTPRESS_PUSH_STORIES_SYNCED, '') !== (string) ($args['mark'] ?? '');
    $matched = [];
    $design_key = agentpress_push_oxygen_ready() ? agentpress_push_design_meta_keys()[0] : '';
    $uploads = wp_get_upload_dir();
    $upload_url = preg_replace('#^https?:#i', '', untrailingslashit((string) $uploads['baseurl']));
    $items = [];
    $media = [];
    $on_live = [];
    $posts = get_posts(['post_type' => 'post', 'post_status' => agentpress_push_story_statuses(), 'posts_per_page' => -1, 'orderby' => 'date', 'order' => 'DESC', 'suppress_filters' => true]);
    foreach ($posts as $post) {
        $picked = false;
        foreach ($only as $want) {
            if ($want === (string) $post->ID || $want === $post->post_name) {
                $picked = true;
                $matched[$want] = true;
            }
        }
        if ($only && !$picked) {
            continue;
        }
        $uid = (string) get_post_meta($post->ID, AGENTPRESS_PUSH_UID, true);
        $sent = $stale ? '' : (string) get_post_meta($post->ID, AGENTPRESS_PUSH_STORY_SENT, true);
        if ($sent === '' && $live !== null && agentpress_push_story_same_row($post->ID, $post->post_date_gmt, $post->post_title, $live)) {
            $sent = 'live';
        }
        $fresh = $sent === '';
        // WordPress's own sample post. Without this the first pull onto a
        // new site is refused over "Hello world!", a story nobody wrote.
        if ($fresh && !$picked && agentpress_push_story_is_sample($post->ID, $post->post_name)) {
            continue;
        }
        if ($sent === 'live') {
            if ($picked) {
                $on_live[] = (string) $post->post_title;
            }
            continue;
        }

        $terms = [];
        foreach (get_object_taxonomies('post') as $tax) {
            if ($tax === 'post_format') {
                continue;
            }
            $found = wp_get_object_terms($post->ID, $tax);
            foreach (is_wp_error($found) ? [] : $found as $term) {
                $chain = [];
                foreach (array_reverse(get_ancestors($term->term_id, $tax, 'taxonomy')) as $parent_id) {
                    $parent = get_term($parent_id, $tax);
                    if ($parent && !is_wp_error($parent)) {
                        $chain[] = ['name' => (string) $parent->name, 'slug' => (string) $parent->slug];
                    }
                }
                $chain[] = ['name' => (string) $term->name, 'slug' => (string) $term->slug];
                $terms[$tax][] = $chain;
            }
        }
        ksort($terms);

        $thumbnail = (int) get_post_thumbnail_id($post->ID);
        $wanted = agentpress_push_story_media_ids($post->post_content);
        $loose = [];
        // An image placed by address alone has no number in the text. Find
        // its library item by the file it names, with the size suffix
        // WordPress adds taken off; a file with no library item still travels.
        if (preg_match_all('#https?:' . preg_quote($upload_url, '#') . '/([^"\'\s<>\)\]\?\#]+)#i', $post->post_content, $m)) {
            foreach (array_unique($m[1]) as $rel) {
                $rel = rawurldecode($rel);
                $plain = preg_replace('/-\d+x\d+(\.[A-Za-z0-9]+)$/', '$1', $rel);
                $hit = (int) $wpdb->get_var($wpdb->prepare("SELECT post_id FROM {$wpdb->postmeta} WHERE meta_key = '_wp_attached_file' AND meta_value IN (%s, %s) ORDER BY post_id ASC LIMIT 1", $rel, $plain));
                if ($hit) {
                    $wanted[] = $hit;
                } elseif (!empty($uploads['basedir']) && is_file($uploads['basedir'] . '/' . $rel)) {
                    $loose[] = ['file' => $rel, 'size' => (int) filesize($uploads['basedir'] . '/' . $rel)];
                }
            }
        }
        if ($thumbnail) {
            $wanted[] = $thumbnail;
        }
        $used = [];
        foreach (array_unique($wanted) as $media_id) {
            if (!isset($media[$media_id])) {
                $media[$media_id] = agentpress_push_story_media_record($media_id);
            }
            if ($media[$media_id]) {
                $used[] = (int) $media_id;
            }
        }
        sort($used);

        $meta = [];
        foreach ((array) get_post_meta($post->ID) as $key => $values) {
            if (agentpress_push_story_meta_skipped((string) $key)) {
                continue;
            }
            $meta[(string) $key] = array_map('strval', (array) $values);
        }
        ksort($meta);

        $author = get_userdata((int) $post->post_author);
        $item = [
            // A story an undo took back keeps the id it went up under: that is how the one in the bin there is found.
            'uid' => preg_match('/^[a-f0-9-]{36}$/', $uid) ? $uid : agentpress_push_story_uid($post),
            'fresh' => $fresh,
            'source_id' => (int) $post->ID,
            'post_title' => (string) $post->post_title,
            'post_name' => (string) $post->post_name,
            'post_content' => (string) $post->post_content,
            'post_excerpt' => (string) $post->post_excerpt,
            'post_status' => (string) $post->post_status,
            'post_date' => (string) $post->post_date,
            'post_date_gmt' => (string) $post->post_date_gmt,
            'post_password' => (string) $post->post_password,
            'comment_status' => (string) $post->comment_status,
            'ping_status' => (string) $post->ping_status,
            'author' => $author ? (string) $author->user_login : '',
            'format' => (string) (get_post_format($post->ID) ?: ''),
            'terms' => $terms,
            'thumbnail' => $thumbnail && !empty($media[$thumbnail]) ? $thumbnail : 0,
            'media' => $used,
            'loose' => $loose,
            'meta' => $meta,
            'builder' => $design_key !== '' && metadata_exists('post', $post->ID, $design_key),
        ];
        // What "changed here since it was sent" is judged on: the story as
        // this site holds it, with nothing the other site adds.
        $facts = $item;
        unset($facts['uid'], $facts['fresh'], $facts['source_id']);
        $facts['thumbnail'] = $item['thumbnail'] ? $media[$item['thumbnail']]['file'] : '';
        $facts['media'] = array_map(function ($id) use ($media) { return $media[$id]['file']; }, $used);
        $item['hash'] = sha1((string) wp_json_encode($facts));
        if (!$fresh && !$picked && $item['hash'] === $sent) {
            continue;
        }
        $items[] = $item;
    }
    return [
        'format' => AGENTPRESS_PUSH_FORMAT,
        'source_url' => site_url(),
        'home_url' => home_url(),
        'items' => $items,
        'media' => array_values(array_filter($media)),
        'on_live' => $on_live,
        'unknown' => array_values(array_filter($only, function ($want) use ($matched) { return !isset($matched[$want]); })),
        'stories' => count($posts),
    ];
}

/**
 * A story as it stands on THIS site, as one fingerprint: its text, status,
 * categories and image. Kept when a story arrives, and compared before it is
 * ever written to again. Equal means nobody here has touched it since.
 */
function agentpress_push_story_live_hash($id)
{
    clean_post_cache($id);
    $post = get_post($id);
    if (!$post) {
        return '';
    }
    $terms = [];
    foreach (get_object_taxonomies('post') as $tax) {
        $ids = wp_get_object_terms($id, $tax, ['fields' => 'ids']);
        $ids = is_wp_error($ids) ? [] : array_map('intval', $ids);
        sort($ids);
        $terms[$tax] = $ids;
    }
    ksort($terms);
    return sha1((string) wp_json_encode([$post->post_title, $post->post_content, $post->post_excerpt, $post->post_status, $post->post_name, $post->post_date, $terms, (int) get_post_thumbnail_id($id)]));
}

/**
 * Where a file a story needs stands on this site. `have`: the same file with
 * a library item. `adopt`: the same file, no library item yet. `new`: not
 * here. `clash`: another file already has that name, and writing over an
 * upload on the receiving site is the one thing this never does.
 */
function agentpress_push_story_media_state($rel, $size)
{
    global $wpdb;
    $abs = is_string($rel) ? agentpress_push_resolve_path('uploads/' . $rel) : null;
    if (!$abs || is_wp_error($abs) || agentpress_push_runs_as_code($rel)) {
        return ['state' => 'bad', 'id' => 0];
    }
    $row = (int) $wpdb->get_var($wpdb->prepare(
        "SELECT m.post_id FROM {$wpdb->postmeta} m JOIN {$wpdb->posts} p ON p.ID = m.post_id
         WHERE m.meta_key = '_wp_attached_file' AND m.meta_value = %s AND p.post_type = 'attachment' ORDER BY m.post_id ASC LIMIT 1",
        $rel
    ));
    if (!is_file($abs)) {
        return ['state' => 'new', 'id' => $row];
    }
    if ((int) filesize($abs) !== (int) $size) {
        return ['state' => 'clash', 'id' => 0];
    }
    return ['state' => $row ? 'have' : 'adopt', 'id' => $row];
}

/** Find or make a category (or tag) by its path of names. `$dry` only says what would be made. */
function agentpress_push_story_term($tax, $chain, $dry, &$made)
{
    $parent = 0;
    $id = 0;
    foreach ((array) $chain as $node) {
        $name = (string) ($node['name'] ?? '');
        $slug = (string) ($node['slug'] ?? '');
        $term = $slug !== '' ? get_term_by('slug', $slug, $tax) : false;
        if (!$term && $name !== '') {
            $term = get_term_by('name', $name, $tax);
        }
        if ($term && !is_wp_error($term)) {
            $id = (int) $term->term_id;
        } elseif ($name === '') {
            return 0;
        } else {
            $made[$tax . ':' . $slug] = $name;
            if ($dry) {
                // Nothing under a category that does not exist yet can exist either.
                $id = -1;
            } else {
                $new = wp_insert_term(wp_slash($name), $tax, ['slug' => $slug, 'parent' => max(0, $parent)]);
                if (is_wp_error($new)) {
                    return 0;
                }
                $id = (int) $new['term_id'];
            }
        }
        $parent = $id;
    }
    return $id;
}

/**
 * Plans, or carries out, the stories in the uploaded bundle. `dry` answers
 * with the plan and writes nothing; `only` is the ids the sender chose;
 * `draft` makes every one arrive as a draft whatever it was. A real run
 * decides everything again from this site as it stands NOW: the plan the
 * sender looked at is a thing shown to a person, not something to act on.
 */
function agentpress_push_op_stories_import($args)
{
    global $wpdb;
    $dry = !empty($args['dry']);
    $draft = !empty($args['draft']);
    $only = isset($args['only']) && is_array($args['only']) ? array_map('strval', $args['only']) : null;
    $dir = agentpress_push_session_dir($args['session'] ?? '');
    if (is_wp_error($dir)) {
        return $dir;
    }
    $bundle = json_decode((string) @file_get_contents($dir . '/stories.json'), true);
    if (!is_array($bundle) || (int) ($bundle['format'] ?? 0) !== AGENTPRESS_PUSH_FORMAT || !isset($bundle['items'], $bundle['media']) || !is_array($bundle['items']) || !is_array($bundle['media'])) {
        return agentpress_push_fail('bad_bundle', 'The stories were not uploaded, or were made by a different version of AgentPress Push.', 422);
    }
    $base = agentpress_push_roots()['uploads'] ?? '';
    if ($base === '') {
        return agentpress_push_fail('bad_root', "This site's uploads folder is not inside wp-content, so a story's images have nowhere to go.", 409);
    }
    $items = [];
    foreach ($bundle['items'] as $item) {
        if (!is_array($item) || !preg_match('/^[a-f0-9-]{36}$/', (string) ($item['uid'] ?? ''))) {
            return agentpress_push_fail('bad_bundle', 'A story in the bundle has no permanent id.', 422);
        }
        if ($only === null || in_array($item['uid'], $only, true)) {
            $items[] = $item;
        }
    }
    if (count($items) > 50) {
        return agentpress_push_fail('too_many', 'That is ' . count($items) . ' stories in one go. Send up to 50 at a time.', 413);
    }
    $library = [];
    foreach ($bundle['media'] as $record) {
        if (is_array($record) && isset($record['id'], $record['file'])) {
            $library[(int) $record['id']] = $record;
        }
    }
    $pairs = agentpress_push_url_pairs([(string) ($bundle['source_url'] ?? ''), (string) ($bundle['home_url'] ?? '')], site_url());
    $admins = get_users(['role' => 'administrator', 'orderby' => 'ID', 'order' => 'ASC', 'number' => 1, 'fields' => 'ID']);
    $fallback_author = $admins ? (int) $admins[0] : 0;
    $fallback_name = $fallback_author ? (string) get_userdata($fallback_author)->user_login : '';

    $states = [];   // source media id => where it stands here
    $plan = [];
    foreach ($items as $i => $item) {
        $status = $draft ? 'draft' : (in_array($item['post_status'] ?? '', agentpress_push_story_statuses(), true) ? $item['post_status'] : 'draft');
        $entry = ['uid' => $item['uid'], 'source_id' => (int) ($item['source_id'] ?? 0), 'title' => (string) ($item['post_title'] ?? ''), 'status' => $status,
            'action' => 'create', 'reason' => '', 'target' => 0, 'images' => 0, 'files' => [], 'notes' => [], 'new_terms' => []];

        $found = get_posts(['post_type' => 'post', 'post_status' => array_merge(agentpress_push_story_statuses(), ['trash']), 'posts_per_page' => 1, 'fields' => 'ids',
            'orderby' => 'ID', 'order' => 'ASC', 'meta_key' => AGENTPRESS_PUSH_UID, 'meta_value' => $item['uid'], 'suppress_filters' => true]);
        if (!empty($item['builder'])) {
            $entry['action'] = 'leave';
            $entry['reason'] = 'builder';
        } elseif (!$found) {
            if (empty($item['fresh'])) {
                $entry['action'] = 'leave';
                $entry['reason'] = 'gone';
            } elseif ((string) ($item['post_name'] ?? '') !== '') {
                // The second check behind the sender's notes: a story already
                // at this address here is either the same story or one the
                // editor wrote. WordPress would make ours `-2` and publish a twin.
                // Asked of the table, not of WP_Query: a query by name is a
                // "single story" query, and WordPress empties its answer when
                // the story is a draft and nobody is logged in. This request
                // has a key, not a login (local test: the editor's draft at
                // the same address was not seen).
                $in = "'" . implode("','", agentpress_push_story_statuses()) . "'";
                $twin = (int) $wpdb->get_var($wpdb->prepare("SELECT ID FROM {$wpdb->posts} WHERE post_type = 'post' AND post_name = %s AND post_status IN ($in) ORDER BY ID ASC LIMIT 1", (string) $item['post_name']));
                if ($twin) {
                    $entry['action'] = 'leave';
                    $entry['reason'] = 'same_address';
                    $entry['target'] = $twin;
                }
            }
        } else {
            $target = (int) $found[0];
            $entry['target'] = $target;
            $arrived = (string) get_post_meta($target, AGENTPRESS_PUSH_STORY_LIVE, true);
            if (get_post_status($target) === 'trash') {
                // In the bin because an undo of ours put it there: take it
                // back out. In the bin for any other reason: somebody's choice.
                $entry['action'] = get_post_meta($target, AGENTPRESS_PUSH_STORY_UNDONE, true) ? 'restore' : 'leave';
                $entry['reason'] = $entry['action'] === 'leave' ? 'binned' : '';
            } elseif ($arrived === '') {
                $entry['action'] = 'leave';
                $entry['reason'] = 'on_live';
            } elseif (agentpress_push_story_live_hash($target) !== $arrived) {
                $entry['action'] = 'leave';
                $entry['reason'] = 'edited';
            } else {
                $entry['action'] = 'update';
            }
        }

        if ($entry['action'] !== 'leave') {
            $wanted = array_map('intval', (array) ($item['media'] ?? []));
            foreach ($wanted as $media_id) {
                if (!isset($library[$media_id])) {
                    continue;
                }
                if (!isset($states[$media_id])) {
                    $record = $library[$media_id];
                    $state = agentpress_push_story_media_state($record['file'], $record['size'] ?? -1);
                    $state['need'] = [];
                    foreach ((array) ($record['files'] ?? []) as $file) {
                        $abs = is_string($file) ? agentpress_push_resolve_path('uploads/' . $file) : null;
                        if (!$abs || is_wp_error($abs) || agentpress_push_runs_as_code($file)) {
                            $state['state'] = 'bad';
                        } elseif (!is_file($abs)) {
                            $state['need'][] = 'uploads/' . $file;
                        }
                    }
                    $states[$media_id] = $state;
                }
                $state = $states[$media_id];
                if ($state['state'] === 'clash' || $state['state'] === 'bad') {
                    $entry['action'] = 'leave';
                    $entry['reason'] = $state['state'] === 'clash' ? 'image_clash' : 'image_bad';
                    $entry['notes'][] = basename((string) $library[$media_id]['file']);
                    break;
                }
                $entry['images']++;
                $entry['files'] = array_merge($entry['files'], $state['need']);
            }
        }
        if ($entry['action'] !== 'leave') {
            foreach ((array) ($item['loose'] ?? []) as $loose) {
                $state = agentpress_push_story_media_state($loose['file'] ?? null, $loose['size'] ?? -1);
                if ($state['state'] === 'clash' || $state['state'] === 'bad') {
                    $entry['action'] = 'leave';
                    $entry['reason'] = $state['state'] === 'clash' ? 'image_clash' : 'image_bad';
                    $entry['notes'][] = basename((string) ($loose['file'] ?? ''));
                    break;
                }
                if ($state['state'] === 'new') {
                    $entry['files'][] = 'uploads/' . $loose['file'];
                }
            }
        }
        if ($entry['action'] === 'leave') {
            $entry['files'] = [];
            $entry['images'] = 0;
        } else {
            $entry['files'] = array_values(array_unique($entry['files']));
            $author = (string) ($item['author'] ?? '');
            if ($author === '' || !get_user_by('login', $author)) {
                $entry['notes'][] = 'author:' . $author . ':' . $fallback_name;
            }
            $made = [];
            foreach ((array) ($item['terms'] ?? []) as $tax => $chains) {
                if (!taxonomy_exists($tax)) {
                    $entry['notes'][] = 'no_taxonomy:' . $tax;
                    continue;
                }
                foreach ((array) $chains as $chain) {
                    agentpress_push_story_term($tax, $chain, true, $made);
                }
            }
            $entry['new_terms'] = array_values($made);
        }
        $plan[$i] = $entry;
    }
    if ($dry) {
        return ['dry' => true, 'draft' => $draft, 'plan' => array_values($plan)];
    }

    // The source is the developer's own site and the content is theirs to
    // publish. Without this WordPress filters the text as an anonymous
    // visitor's (this request has a key, not a login) and an embed or a
    // script block arrives as nothing.
    kses_remove_filters();
    $record = ['created' => [], 'restored' => [], 'updated' => [], 'attachments' => [], 'at' => gmdate('c')];
    $made_media = [];   // source media id => this site's id
    $sent = [];
    foreach ($items as $i => $item) {
        $entry = $plan[$i];
        if ($entry['action'] === 'leave') {
            continue;
        }
        $fail = function ($why) use (&$plan, $i) {
            $plan[$i]['action'] = 'failed';
            $plan[$i]['reason'] = $why;
        };

        // Images first: the text and the featured image point at their numbers.
        $map = [];
        $ok = true;
        foreach (array_map('intval', (array) ($item['media'] ?? [])) as $media_id) {
            if (!isset($library[$media_id])) {
                continue;
            }
            if (!isset($made_media[$media_id])) {
                $media = $library[$media_id];
                $state = agentpress_push_story_media_state($media['file'], $media['size'] ?? -1);
                if ($state['state'] === 'have') {
                    $made_media[$media_id] = (int) $state['id'];
                } elseif ($state['state'] === 'adopt') {
                    $attachment = wp_insert_attachment(wp_slash([
                        'post_title' => (string) ($media['title'] ?? ''), 'post_content' => (string) ($media['description'] ?? ''), 'post_excerpt' => (string) ($media['caption'] ?? ''),
                        'post_mime_type' => (string) ($media['mime'] ?? ''), 'post_status' => 'inherit', 'post_date' => (string) ($media['date'] ?? ''),
                        'post_author' => $fallback_author,
                    // The path as WordPress stores it: relative to uploads.
                    // Given the full path, WordPress only shortens it when it
                    // starts with its own spelling of the uploads folder, and
                    // on Windows that spelling has a backslash ours does not.
                    // First local run: the row kept `C:/...` whole, the image
                    // was "missing" to WordPress with the file sitting there,
                    // and a second send would not have found the row.
                    ]), (string) $media['file'], 0, true);
                    if (is_wp_error($attachment)) {
                        $ok = false;
                        break;
                    }
                    if (is_array($media['meta'] ?? null)) {
                        wp_update_attachment_metadata($attachment, $media['meta']);
                    }
                    if ((string) ($media['alt'] ?? '') !== '') {
                        update_post_meta($attachment, '_wp_attachment_image_alt', wp_slash((string) $media['alt']));
                    }
                    $made_media[$media_id] = (int) $attachment;
                    $record['attachments'][] = (int) $attachment;
                } else {
                    // Still not here after the files were sent: do not publish a story with a hole in it.
                    $ok = false;
                    break;
                }
            }
            $map[$media_id] = $made_media[$media_id];
        }
        if (!$ok) {
            $fail('image_missing');
            continue;
        }

        $author = get_user_by('login', (string) ($item['author'] ?? ''));
        $content = agentpress_push_story_rewrite_ids(agentpress_push_replace_value((string) ($item['post_content'] ?? ''), $pairs), $map);
        $fields = [
            'post_type' => 'post',
            'post_status' => $entry['status'],
            'post_title' => (string) ($item['post_title'] ?? ''),
            'post_name' => (string) ($item['post_name'] ?? ''),
            'post_content' => $content,
            'post_excerpt' => agentpress_push_replace_value((string) ($item['post_excerpt'] ?? ''), $pairs),
            'post_date' => (string) ($item['post_date'] ?? ''),
            'post_date_gmt' => (string) ($item['post_date_gmt'] ?? ''),
            'post_password' => (string) ($item['post_password'] ?? ''),
            'comment_status' => (string) ($item['comment_status'] ?? 'closed'),
            'ping_status' => (string) ($item['ping_status'] ?? 'closed'),
            'post_author' => $author ? (int) $author->ID : $fallback_author,
        ];

        $target = (int) $entry['target'];
        if ($entry['action'] === 'create') {
            $target = wp_insert_post(wp_slash($fields), true);
            if (is_wp_error($target) || !$target) {
                $fail('insert');
                continue;
            }
            $target = (int) $target;
            $record['created'][] = $target;
        } else {
            if ($entry['action'] === 'restore') {
                wp_untrash_post($target);
                $record['restored'][] = $target;
            } else {
                $before = get_post($target, ARRAY_A);
                $terms_before = [];
                foreach (get_object_taxonomies('post') as $tax) {
                    $ids = wp_get_object_terms($target, $tax, ['fields' => 'ids']);
                    $terms_before[$tax] = is_wp_error($ids) ? [] : array_map('intval', $ids);
                }
                $record['updated'][$target] = [
                    'fields' => array_intersect_key((array) $before, array_flip(['post_title', 'post_name', 'post_content', 'post_excerpt', 'post_status', 'post_date', 'post_date_gmt', 'post_password', 'comment_status', 'ping_status', 'post_author'])),
                    'terms' => $terms_before,
                    'thumbnail' => (int) get_post_thumbnail_id($target),
                ];
            }
            $done = wp_update_post(wp_slash(array_merge($fields, ['ID' => $target])), true);
            if (is_wp_error($done)) {
                $fail('update');
                continue;
            }
        }

        foreach ((array) ($item['terms'] ?? []) as $tax => $chains) {
            if (!taxonomy_exists($tax)) {
                continue;
            }
            $ids = [];
            $unused = [];
            foreach ((array) $chains as $chain) {
                $term_id = agentpress_push_story_term($tax, $chain, false, $unused);
                if ($term_id > 0) {
                    $ids[] = $term_id;
                }
            }
            wp_set_object_terms($target, $ids, $tax, false);
        }
        if (current_theme_supports('post-formats') || (string) ($item['format'] ?? '') === '') {
            set_post_format($target, (string) ($item['format'] ?? ''));
        }
        $thumbnail = (int) ($item['thumbnail'] ?? 0);
        if ($thumbnail && isset($map[$thumbnail])) {
            set_post_thumbnail($target, $map[$thumbnail]);
        } else {
            delete_post_thumbnail($target);
        }
        foreach ((array) ($item['meta'] ?? []) as $key => $values) {
            $key = (string) $key;
            if ($key === '' || agentpress_push_story_meta_skipped($key)) {
                continue;
            }
            delete_post_meta($target, $key);
            foreach ((array) $values as $value) {
                // Stored values arrive as WordPress stored them. One that
                // was serialized is unpacked first, or add_post_meta would
                // serialize the string a second time. Never into an object.
                $value = (string) $value;
                if (is_serialized($value)) {
                    $unpacked = @unserialize($value, ['allowed_classes' => false]);
                    if ($unpacked === false && $value !== 'b:0;') {
                        continue;
                    }
                    if (is_object($unpacked) || strpos($value, 'O:') !== false || strpos($value, 'C:') !== false) {
                        continue;
                    }
                    $value = agentpress_push_replace_deep($unpacked, $pairs);
                } else {
                    $value = agentpress_push_replace_value($value, $pairs);
                }
                add_post_meta($target, $key, wp_slash($value));
            }
        }
        update_post_meta($target, AGENTPRESS_PUSH_UID, $item['uid']);
        delete_post_meta($target, AGENTPRESS_PUSH_STORY_UNDONE);
        update_post_meta($target, AGENTPRESS_PUSH_STORY_LIVE, agentpress_push_story_live_hash($target));
        $plan[$i]['target'] = $target;
        $plan[$i]['url'] = (string) get_permalink($target);
        $sent[] = ['id' => (int) ($item['source_id'] ?? 0), 'uid' => $item['uid'], 'hash' => (string) ($item['hash'] ?? '')];
    }
    kses_init();

    $undo = null;
    if ($record['created'] || $record['restored'] || $record['updated']) {
        $undo_dir = agentpress_push_data_dir() . '/stories-sent';
        wp_mkdir_p($undo_dir);
        if (!file_exists($undo_dir . '/index.php')) {
            @file_put_contents($undo_dir . '/index.php', "<?php\n// Silence is golden.\n");
        }
        $undo = 'stories-' . gmdate('Ymd-His') . '-' . bin2hex(random_bytes(16)) . '.json';
        @file_put_contents($undo_dir . '/' . $undo, wp_json_encode($record));
        $kept = glob($undo_dir . '/stories-*.json*') ?: [];
        sort($kept);
        foreach (array_slice($kept, 0, max(0, count($kept) - 10)) as $old) {
            @unlink($old);
        }
    }
    wp_cache_flush();
    return ['dry' => false, 'draft' => $draft, 'plan' => array_values($plan), 'sent' => $sent, 'undo' => $undo];
}

/**
 * Takes back the last send: stories it made go to the bin (marked, so that
 * sending them again takes them back out instead of making a twin), and a
 * story it changed gets the text it had before. Each send is undone once.
 */
function agentpress_push_op_stories_undo($args)
{
    $kept = glob(agentpress_push_data_dir() . '/stories-sent/stories-*.json') ?: [];
    sort($kept);
    $file = end($kept);
    $record = $file ? json_decode((string) file_get_contents($file), true) : null;
    if (!is_array($record)) {
        return agentpress_push_fail('no_undo', 'No stories were sent to this site that can still be taken back.', 404);
    }
    $dry = !empty($args['dry']);
    $binned = [];
    $reverted = [];
    $uids = [];
    $reverted_uids = [];
    kses_remove_filters();
    foreach (array_merge((array) ($record['created'] ?? []), (array) ($record['restored'] ?? [])) as $id) {
        $id = (int) $id;
        $post = get_post($id);
        if (!$post || $post->post_type !== 'post' || $post->post_status === 'trash') {
            continue;
        }
        $binned[] = (string) $post->post_title;
        $uids[] = (string) get_post_meta($id, AGENTPRESS_PUSH_UID, true);
        if (!$dry) {
            update_post_meta($id, AGENTPRESS_PUSH_STORY_UNDONE, '1');
            wp_trash_post($id);
        }
    }
    foreach ((array) ($record['updated'] ?? []) as $id => $was) {
        $id = (int) $id;
        $post = get_post($id);
        if (!$post || $post->post_type !== 'post' || $post->post_status === 'trash' || !is_array($was['fields'] ?? null)) {
            continue;
        }
        $reverted[] = (string) $post->post_title;
        $reverted_uids[] = (string) get_post_meta($id, AGENTPRESS_PUSH_UID, true);
        if (!$dry) {
            wp_update_post(wp_slash(array_merge($was['fields'], ['ID' => $id])));
            foreach ((array) ($was['terms'] ?? []) as $tax => $ids) {
                if (taxonomy_exists($tax)) {
                    wp_set_object_terms($id, array_map('intval', (array) $ids), $tax, false);
                }
            }
            if (!empty($was['thumbnail'])) {
                set_post_thumbnail($id, (int) $was['thumbnail']);
            } else {
                delete_post_thumbnail($id);
            }
            // Back as it was sent the time before, and still untouched by anyone here.
            update_post_meta($id, AGENTPRESS_PUSH_STORY_LIVE, agentpress_push_story_live_hash($id));
        }
    }
    kses_init();
    if (!$dry) {
        @rename($file, $file . '.undone');
        wp_cache_flush();
    }
    return ['dry' => $dry, 'binned' => $binned, 'reverted' => $reverted, 'uids' => array_values(array_filter($uids)), 'reverted_uids' => array_values(array_filter($reverted_uids)), 'sent_at' => (string) ($record['at'] ?? '')];
}

/**
 * The dev site's own note of what went up. `sent`: these stories are on the
 * live site now, under this id, as they stood at this fingerprint. `unsent`:
 * these were taken back there, so here they are stories written here again.
 * `changed`: an update to these was taken back there, so what is here is
 * newer than what is there, and they are offered again.
 */
function agentpress_push_op_stories_mark($args)
{
    $marked = 0;
    foreach ((array) ($args['sent'] ?? []) as $row) {
        $id = (int) ($row['id'] ?? 0);
        $uid = (string) ($row['uid'] ?? '');
        if (!$id || get_post_type($id) !== 'post' || !preg_match('/^[a-f0-9-]{36}$/', $uid)) {
            continue;
        }
        update_post_meta($id, AGENTPRESS_PUSH_UID, $uid);
        update_post_meta($id, AGENTPRESS_PUSH_STORY_SENT, (string) ($row['hash'] ?? ''));
        $marked++;
    }
    $cleared = 0;
    foreach ((array) ($args['unsent'] ?? []) as $uid) {
        if (!is_string($uid) || !preg_match('/^[a-f0-9-]{36}$/', $uid)) {
            continue;
        }
        $ids = get_posts(['post_type' => 'post', 'post_status' => 'any', 'posts_per_page' => -1, 'fields' => 'ids', 'meta_key' => AGENTPRESS_PUSH_UID, 'meta_value' => $uid, 'suppress_filters' => true]);
        foreach ($ids as $id) {
            // The id stays: it is how the story in the bin there is found if this one is sent again.
            delete_post_meta($id, AGENTPRESS_PUSH_STORY_SENT);
            $cleared++;
        }
    }
    foreach ((array) ($args['changed'] ?? []) as $uid) {
        if (!is_string($uid) || !preg_match('/^[a-f0-9-]{36}$/', $uid)) {
            continue;
        }
        $ids = get_posts(['post_type' => 'post', 'post_status' => 'any', 'posts_per_page' => -1, 'fields' => 'ids', 'meta_key' => AGENTPRESS_PUSH_UID, 'meta_value' => $uid, 'suppress_filters' => true]);
        foreach ($ids as $id) {
            // Any value that is not a fingerprint of the story as it stands.
            update_post_meta($id, AGENTPRESS_PUSH_STORY_SENT, 'changed');
            $cleared++;
        }
    }
    return ['marked' => $marked, 'cleared' => $cleared];
}

/* ------------------------------------------------------------------------
 * After a copy lands
 * --------------------------------------------------------------------- */

/**
 * Oxygen writes a CSS file per post; after a copy those files describe the
 * old rows, so the page keeps its old look until they are rebuilt. Stepped,
 * because rendering every built post is the slowest thing in the whole job.
 */
function agentpress_push_op_rebuild_css($args)
{
    $state = is_array($args['state'] ?? null) ? $args['state'] : [];
    $state += ['page' => 0, 'i' => 0, 'posts' => 0, 'global' => false];
    if (!function_exists('\Breakdance\Data\get_paginated_breakdance_post_ids') || !function_exists('\Breakdance\Render\generateCacheForPost')) {
        return ['done' => true, 'state' => $state, 'posts' => 0, 'skipped' => 'Oxygen is not active'];
    }
    if (!$state['global'] && function_exists('\Breakdance\Data\regenerate_global_settings_cache')) {
        \Breakdance\Data\regenerate_global_settings_cache();
        $state['global'] = true;
    }
    $deadline = agentpress_push_deadline();
    $done = false;
    while (microtime(true) < $deadline) {
        $result = \Breakdance\Data\get_paginated_breakdance_post_ids((int) $state['page']);
        $ids = array_map('intval', (array) ($result['postIds'] ?? []));
        if (!$ids) {
            $done = true;
            break;
        }
        // The clock is checked after every post, not every page of posts: one
        // post took about 3.5 seconds on the first timed run, so a page of
        // seventeen ran for a minute inside a single request.
        while ($state['i'] < count($ids) && microtime(true) < $deadline) {
            \Breakdance\Render\generateCacheForPost($ids[$state['i']]);
            $state['i']++;
            $state['posts']++;
        }
        if ($state['i'] >= count($ids)) {
            $state['page']++;
            $state['i'] = 0;
        }
    }
    return ['done' => $done, 'state' => $state, 'posts' => $state['posts']];
}

/**
 * Last step of every push and pull. The page cache matters most on the
 * hosts this is built for: WP Toolkit switches LiteSpeed Cache on by itself,
 * and it goes on serving the page from before the push to everyone.
 */
function agentpress_push_op_finish($args)
{
    $done = [];
    wp_cache_flush();
    delete_option('rewrite_rules');
    $done[] = 'permalinks';
    $done = array_merge($done, agentpress_push_purge_page_cache());
    if (!empty($args['session'])) {
        agentpress_push_op_session_end(['session' => $args['session']]);
    }
    return ['cleared' => $done];
}

/* ------------------------------------------------------------------------
 * Dispatch: one table, two front doors (REST for a remote site, WP-CLI for
 * the local one). The same function answers both.
 * --------------------------------------------------------------------- */

function agentpress_push_ops()
{
    return [
        'info' => 'agentpress_push_op_info',
        'session_new' => 'agentpress_push_op_session_new',
        'session_end' => 'agentpress_push_op_session_end',
        'db_export' => 'agentpress_push_op_db_export',
        'db_import' => 'agentpress_push_op_db_import',
        'db_swap' => 'agentpress_push_op_db_swap',
        'db_undo' => 'agentpress_push_op_db_undo',
        'files_manifest' => 'agentpress_push_op_files_manifest',
        'files_pack' => 'agentpress_push_op_files_pack',
        'files_unpack' => 'agentpress_push_op_files_unpack',
        'design_export' => 'agentpress_push_op_design_export',
        'design_apply' => 'agentpress_push_op_design_apply',
        'design_undo' => 'agentpress_push_op_design_undo',
        'stories_index' => 'agentpress_push_op_stories_index',
        'stories_level' => 'agentpress_push_op_stories_level',
        'stories_export' => 'agentpress_push_op_stories_export',
        'stories_import' => 'agentpress_push_op_stories_import',
        'stories_undo' => 'agentpress_push_op_stories_undo',
        'stories_mark' => 'agentpress_push_op_stories_mark',
        'pages_access' => 'agentpress_push_op_pages_access',
        'editor_view' => 'agentpress_push_op_editor_view',
        'rebuild_css' => 'agentpress_push_op_rebuild_css',
        'finish' => 'agentpress_push_op_finish',
    ];
}

function agentpress_push_run($op, $args)
{
    $ops = agentpress_push_ops();
    if (!isset($ops[$op])) {
        return agentpress_push_fail('unknown_op', 'Unknown operation: ' . $op, 404);
    }
    // A long step must not be cut short by a visitor closing a tab, and the
    // step budget is set well under any sane limit, but ask for headroom anyway.
    @set_time_limit(120);
    ignore_user_abort(true);
    $args = is_array($args) ? $args : [];
    // A numbered step is answered at most once. The caller retries when a
    // reply is lost (a shared host's gateway gives up at 30-60s while PHP
    // carries on and finishes), and a database step run twice would load the
    // same rows twice. So the reply to step N is kept, and a second request
    // for step N gets that reply instead of a second run.
    $memo = null;
    $lock = null;
    if (isset($args['seq'], $args['session']) && preg_match('/^[a-z_]+$/', $op)) {
        $dir = agentpress_push_session_dir($args['session']);
        if (!is_wp_error($dir)) {
            $memo = $dir . '/step-' . $op . '.json';
            // One at a time. The kept reply only exists once the first
            // attempt has FINISHED, and the retry arrives 1.5 seconds after
            // the gateway gave up on it - while it is still running. Without
            // the lock both ran: a database step loaded its rows twice, and a
            // switch or an undo happened twice. The retry now waits here,
            // then finds the reply below.
            $lock = @fopen($dir . '/step-' . $op . '.lock', 'cb');
            if ($lock) {
                @flock($lock, LOCK_EX);
            }
            $kept = is_file($memo) ? json_decode((string) file_get_contents($memo), true) : null;
            if (is_array($kept) && (string) $kept['seq'] === (string) $args['seq']) {
                if ($lock) {
                    fclose($lock);
                }
                return $kept['result'];
            }
        }
    }
    try {
        $result = call_user_func($ops[$op], $args);
    } catch (Throwable $e) {
        $result = agentpress_push_fail('crashed', $op . ' stopped with an error: ' . $e->getMessage(), 500);
    }
    if ($memo && !is_wp_error($result)) {
        @file_put_contents($memo, wp_json_encode(['seq' => (string) $args['seq'], 'result' => $result]), LOCK_EX);
    }
    if ($lock) {
        fclose($lock); // closing releases it
    }
    return $result;
}

add_action('rest_api_init', function () {
    if (is_multisite()) {
        // See agentpress_push_admin_page: one site's administrator must not
        // hold a key that writes code for the whole network.
        return;
    }
    register_rest_route('agentpress-push/v1', '/run', [
        'methods' => 'POST',
        'permission_callback' => 'agentpress_push_rest_permission',
        'callback' => function ($request) {
            $body = json_decode((string) $request->get_body(), true);
            return rest_ensure_response(agentpress_push_run((string) ($body['op'] ?? ''), $body['args'] ?? []));
        },
    ]);
    register_rest_route('agentpress-push/v1', '/put', [
        'methods' => 'POST',
        'permission_callback' => 'agentpress_push_rest_permission',
        'callback' => function ($request) {
            return rest_ensure_response(agentpress_push_put((string) $request->get_param('session'), (string) $request->get_param('name'), (int) $request->get_param('offset'), (string) $request->get_body()));
        },
    ]);
    register_rest_route('agentpress-push/v1', '/get', [
        'methods' => 'GET',
        'permission_callback' => 'agentpress_push_rest_permission',
        'callback' => function ($request) {
            $dir = agentpress_push_session_dir((string) $request->get_param('session'));
            if (is_wp_error($dir)) {
                return $dir;
            }
            $name = (string) $request->get_param('name');
            if (!in_array($name, agentpress_push_session_files(), true) || !is_file($dir . '/' . $name)) {
                return agentpress_push_fail('no_file', 'That file is not in this session.', 404);
            }
            $path = $dir . '/' . $name;
            $size = filesize($path);
            $offset = max(0, (int) $request->get_param('offset'));
            $length = max(0, min((int) $request->get_param('length') ?: 4194304, 8388608, $size - $offset));
            $in = fopen($path, 'rb');
            fseek($in, $offset);
            $bytes = $length > 0 ? fread($in, $length) : '';
            fclose($in);
            // Raw bytes, sent here rather than through the REST response
            // object, which would JSON-encode them.
            nocache_headers();
            header('Content-Type: application/octet-stream');
            header('Content-Length: ' . strlen($bytes));
            header('X-AgentPress-Total: ' . $size);
            echo $bytes;
            exit;
        },
    ]);
});

if (defined('WP_CLI') && WP_CLI) {
    /**
     * wp agentpress-push run <op> [--args-file=<path>]
     * wp agentpress-push key
     *
     * Prints exactly one line of JSON. The local `agentpress push` reads it.
     */
    WP_CLI::add_command('agentpress-push', function ($positional, $assoc) {
        $command = $positional[0] ?? '';
        if ($command === 'key') {
            $result = agentpress_push_key_create();
        } elseif ($command === 'run') {
            $args = [];
            if (!empty($assoc['args-file'])) {
                $args = json_decode((string) file_get_contents($assoc['args-file']), true);
            }
            $result = agentpress_push_run((string) ($positional[1] ?? ''), is_array($args) ? $args : []);
        } else {
            $result = agentpress_push_fail('usage', 'Usage: wp agentpress-push run <op> [--args-file=<path>] | key');
        }
        if (is_wp_error($result)) {
            $result = ['error' => ['code' => $result->get_error_code(), 'message' => $result->get_error_message()]];
        }
        WP_CLI::line('AGENTPRESS_PUSH_JSON ' . wp_json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    });
}

/* ------------------------------------------------------------------------
 * Tools > AgentPress Push
 * --------------------------------------------------------------------- */

add_action('admin_menu', function () {
    add_management_page('AgentPress Push', 'AgentPress Push', 'manage_options', 'agentpress-push', 'agentpress_push_admin_page');
});

function agentpress_push_admin_page()
{
    if (!current_user_can('manage_options')) {
        return;
    }
    // A connection key can write plugin files and replace the database. So
    // it is only for someone already allowed to do that by hand: not on a
    // multisite (where an administrator of ONE site would gain the whole
    // network's code), and not where file changes are switched off
    // (DISALLOW_FILE_MODS takes `install_plugins` away from administrators).
    if (is_multisite() || !current_user_can('install_plugins')) {
        echo '<div class="wrap"><h1>AgentPress Push</h1><div class="notice notice-warning"><p>';
        echo is_multisite()
            ? 'AgentPress Push does not run on a WordPress multisite.'
            : 'A connection key can install plugin files, and your account is not allowed to do that on this site (file changes may be switched off with DISALLOW_FILE_MODS). No key can be created here.';
        echo '</p></div></div>';
        return;
    }
    $made = null;
    if (isset($_POST['agentpress_push_action']) && check_admin_referer('agentpress_push_key')) {
        if ($_POST['agentpress_push_action'] === 'create') {
            $made = agentpress_push_key_create();
        } elseif ($_POST['agentpress_push_action'] === 'revoke') {
            agentpress_push_key_revoke();
        } elseif ($_POST['agentpress_push_action'] === 'editor_view') {
            // A ticked box is a thing editors SEE. Anything not in the list we offer is ignored.
            $ticked = array_map('sanitize_key', (array) wp_unslash($_POST['agentpress_push_show'] ?? []));
            $all = array_keys(agentpress_push_editor_items());
            $show = array_values(array_intersect($all, $ticked));
            agentpress_push_editor_hidden(array_values(array_diff($all, $show)), $show);
        }
    }
    $record = agentpress_push_key_record();
    echo '<div class="wrap"><h1>AgentPress Push</h1>';
    echo '<p>This lets one local AgentPress site push its design to this site, and pull this site\'s content back down.</p>';
    if (is_wp_error($made)) {
        echo '<div class="notice notice-error"><p>' . esc_html($made->get_error_message()) . '</p></div>';
    } elseif (is_array($made)) {
        echo '<div class="notice notice-success"><p><strong>Connection key created.</strong> Copy this line now. It is shown once.</p>';
        echo '<p><textarea readonly rows="3" style="width:100%;font-family:monospace" onclick="this.select()">' . esc_textarea($made['connection']) . '</textarea></p>';
        echo '<p>In the local site\'s folder run: <code>npx create-agentpress@latest push connect &lt;that line&gt;</code></p></div>';
    }
    if (!is_ssl() && !agentpress_push_is_local_host()) {
        echo '<div class="notice notice-warning"><p>This site is not on https. AgentPress Push refuses to answer over plain http on a public site.</p></div>';
    }
    echo '<p>Status: ' . ($record ? 'a connection key exists, created ' . esc_html(gmdate('j M Y H:i', (int) $record['created'])) . ' UTC.' : 'no connection key. Nothing can push to or pull from this site.') . '</p>';
    echo '<form method="post">';
    wp_nonce_field('agentpress_push_key');
    echo '<p><button class="button button-primary" name="agentpress_push_action" value="create">' . ($record ? 'Replace the connection key' : 'Create a connection key') . '</button> ';
    if ($record) {
        echo '<button class="button" name="agentpress_push_action" value="revoke">Revoke it</button>';
    }
    echo '</p></form>';
    echo '<p class="description">Replacing or revoking the key disconnects the local site that holds the old one.</p>';
    $hidden = agentpress_push_editor_hidden();
    $notes = [
        'pages' => 'Unticked, only administrators can edit pages. A page built in Oxygen is replaced by the next design push, whatever was changed here.',
        'comments' => 'The Comments screen and the comment bubble in the toolbar.',
        'tools' => 'The Tools menu.',
        'news' => 'The "WordPress Events and News" box on the dashboard and the W menu in the toolbar.',
    ];
    echo '<h2>What editors see</h2>';
    echo '<p>Tick what people who are not administrators should see in wp-admin. Administrators always see everything.</p>';
    echo '<form method="post">';
    wp_nonce_field('agentpress_push_key');
    echo '<fieldset>';
    foreach (agentpress_push_editor_items() as $key => $label) {
        echo '<p><label><input type="checkbox" name="agentpress_push_show[]" value="' . esc_attr($key) . '"' . (in_array($key, $hidden, true) ? '' : ' checked') . '> <strong>' . esc_html($label) . '</strong></label><br><span class="description">' . esc_html($notes[$key] ?? '') . '</span></p>';
    }
    echo '</fieldset>';
    echo '<p><button class="button button-primary" name="agentpress_push_action" value="editor_view">Save</button></p></form>';
    echo '<p class="description">Posts, Media and Profile are always there: they are the job. Appearance, Plugins, Users, Settings and Oxygen are never shown to an editor, so they are not in this list.</p></div>';
}
