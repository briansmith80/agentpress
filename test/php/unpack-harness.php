<?php
// Test harness, not shipped (package.json's `files` leaves test/ out).
//
// Stubs the handful of WordPress functions the receiver needs, builds a fake
// wp-content in a temp folder, and drives the REAL files_unpack with one
// single-record pack per path, so every path gets its own verdict. A security
// review (2026-11-11) used the same shape to show that a pull would unpack
// `mu-plugins/evil.php` sent by the live site; this is that proof, kept.
//
// In:  $HARNESS = ['plugin' => path, 'base' => dir, 'roots' => [...]|null,
//                  'refuse_code' => bool, 'uploads' => basedir override|null,
//                  'paths' => [...]]
// Out: OUT:<base64 json {results: {path: verdict}, planted: [files that
//      landed, relative to the fake site], receiver_intact: bool}>

$base = str_replace(chr(92), '/', $HARNESS['base']) . '/site';
@mkdir("$base/wp-content/uploads", 0777, true);
@mkdir("$base/wp-content/plugins/agentpress-push", 0777, true);
@mkdir("$base/wp-content/mu-plugins", 0777, true);
@mkdir("$base/wp-content/themes", 0777, true);
@mkdir("$base/outside", 0777, true);
copy($HARNESS['plugin'], "$base/wp-content/plugins/agentpress-push/agentpress-push.php");
file_put_contents("$base/wp-content/plugins/agentpress-push/marker.txt", 'ORIGINAL');

define('ABSPATH', "$base/");
define('WP_CONTENT_DIR', "$base/wp-content");
define('WP_PLUGIN_DIR', "$base/wp-content/plugins");
define('WPMU_PLUGIN_DIR', "$base/wp-content/mu-plugins");
define('MINUTE_IN_SECONDS', 60);
define('HOUR_IN_SECONDS', 3600);
define('DAY_IN_SECONDS', 86400);

class WP_Error
{
    public $code;
    public $message;
    public function __construct($code = '', $message = '', $data = [])
    {
        $this->code = $code;
        $this->message = $message;
    }
    public function get_error_message()
    {
        return $this->message;
    }
    public function get_error_code()
    {
        return $this->code;
    }
}
function is_wp_error($x)
{
    return $x instanceof WP_Error;
}
function add_action()
{
}
function wp_mkdir_p($d)
{
    return is_dir($d) || @mkdir($d, 0777, true);
}
function wp_normalize_path($p)
{
    $p = str_replace(chr(92), '/', (string) $p);
    $p = preg_replace('|(?<=.)/+|', '/', $p);
    if (':' === substr($p, 1, 1)) {
        $p = ucfirst($p);
    }
    return $p;
}
function untrailingslashit($s)
{
    return rtrim((string) $s, '/' . chr(92));
}
function wp_upload_dir()
{
    global $HARNESS;
    return ['basedir' => $HARNESS['uploads'] ?? (WP_CONTENT_DIR . '/uploads')];
}
function get_theme_root()
{
    return WP_CONTENT_DIR . '/themes';
}
function wp_json_encode($d, $f = 0)
{
    return json_encode($d, $f);
}

// The plugin under test is the copy INSIDE the fake site, so __DIR__ in it is
// the folder a hostile pack would be aiming at.
require "$base/wp-content/plugins/agentpress-push/agentpress-push.php";

$session = str_repeat('ab', 16);
$sdir = agentpress_push_data_dir() . '/s-' . $session;
@mkdir($sdir, 0777, true);

$results = [];
foreach ($HARNESS['paths'] as $p) {
    $body = 'PLANTED';
    file_put_contents("$sdir/files.pack", json_encode(['p' => $p, 's' => strlen($body)]) . "\n" . $body . "\n");
    $args = ['session' => $session, 'refuse_code' => !empty($HARNESS['refuse_code'])];
    if ($HARNESS['roots'] !== null) {
        $args['roots'] = $HARNESS['roots'];
    }
    try {
        $r = @agentpress_push_op_files_unpack($args);
        if (is_wp_error($r)) {
            $results[$p] = 'error:' . str_replace('agentpress_push_', '', $r->code);
        } elseif (!empty($r['refused'])) {
            $results[$p] = 'refused';
        } else {
            $results[$p] = $r['written'] ? 'written' : 'skipped';
        }
    } catch (Throwable $e) {
        $results[$p] = 'threw:' . get_class($e);
    }
}

$tree = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    $rel = substr(str_replace(chr(92), '/', $f->getPathname()), strlen($base) + 1);
    if (strpos($rel, 'agentpress-push-data') === false && file_get_contents($f->getPathname()) === 'PLANTED') {
        $tree[] = $rel;
    }
}
sort($tree);
echo 'OUT:' . base64_encode(json_encode([
    'results' => $results,
    'planted' => $tree,
    'receiver_intact' => file_get_contents("$base/wp-content/plugins/agentpress-push/marker.txt") === 'ORIGINAL'
        && strpos((string) file_get_contents("$base/wp-content/plugins/agentpress-push/agentpress-push.php"), 'PLANTED') !== 0,
]));
