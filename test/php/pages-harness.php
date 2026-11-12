<?php
// Test harness, not shipped (package.json's `files` leaves test/ out).
//
// Loads the REAL plugin and asks its pages lock what three kinds of account
// may do, on a site whose address is given. The lock is a capability filter:
// wrong one way an editor on a client's live site keeps editing pages the
// next design push replaces, wrong the other an administrator is shut out of
// their own site. Neither shows up until someone logs in.
//
// In:  $HARNESS = ['plugin' => path, 'content_dir' => empty temp folder,
//                  'site_url' => string, 'steps' => ['', 'open', 'locked', ...]]
// Out: OUT:<base64 json>, one entry per step ('' = ask without choosing)

define('ABSPATH', __DIR__ . '/');
define('WP_CONTENT_DIR', $HARNESS['content_dir']);
function add_action()
{
}
function add_filter()
{
}
function register_activation_hook()
{
}
function site_url()
{
    global $HARNESS;
    return $HARNESS['site_url'];
}
function wp_parse_url($url, $part = -1)
{
    return parse_url($url, $part);
}
function sanitize_key($key)
{
    return preg_replace('/[^a-z0-9_\-]/', '', strtolower((string) $key));
}
function wp_mkdir_p($dir)
{
    return is_dir($dir) || mkdir($dir, 0777, true);
}
// What the plugin answers a bad request with. Only its being one is checked.
class WP_Error
{
    public function __construct(public $code = '', public $message = '', public $data = [])
    {
    }
}

require $HARNESS['plugin'];

// What WordPress hands the filter: every capability the account's role grants.
$page = ['edit_pages', 'edit_others_pages', 'edit_published_pages', 'edit_private_pages', 'publish_pages', 'delete_pages', 'delete_others_pages', 'delete_published_pages', 'delete_private_pages'];
$story = ['edit_posts', 'edit_others_posts', 'edit_published_posts', 'publish_posts', 'delete_posts', 'upload_files', 'moderate_comments', 'read'];
$accounts = [
    'administrator' => array_fill_keys(array_merge($page, $story, ['manage_options']), true),
    'editor' => array_fill_keys(array_merge($page, $story), true),
    'author' => array_fill_keys(['edit_posts', 'edit_published_posts', 'publish_posts', 'delete_posts', 'upload_files', 'read'], true),
];

$out = [];
foreach ($HARNESS['steps'] as $step) {
    $state = agentpress_push_op_pages_access($step === '' ? [] : ['set' => $step]);
    $entry = ['open' => $state['open'], 'chosen' => $state['chosen'], 'accounts' => []];
    foreach ($accounts as $role => $caps) {
        $after = agentpress_push_lock_pages($caps);
        $entry['accounts'][$role] = [
            'pages' => count(array_filter(array_intersect_key($after, array_flip($page)))),
            'stories' => count(array_filter(array_intersect_key($after, array_flip($story)))),
            // A capability the role never had must not appear, true or false.
            'added' => array_values(array_diff(array_keys($after), array_keys($caps))),
        ];
    }
    $out[] = $entry;
}
$bad = agentpress_push_op_pages_access(['set' => 'everyone']);

// The wider list (0.1.11). Starts from "never chosen" again, then a sequence of requests.
@unlink(WP_CONTENT_DIR . '/agentpress-push-data/pages-access.txt');
$keys = static function ($result) {
    return array_values(array_map(static fn ($item) => $item['key'], array_filter($result['items'], static fn ($item) => $item['hidden'])));
};
$editor = [
    $keys(agentpress_push_op_editor_view([])),
    $keys(agentpress_push_op_editor_view(['hide' => ['news', 'comments']])),
    $keys(agentpress_push_op_editor_view(['show' => ['pages']])),
    $keys(agentpress_push_op_editor_view(['hide' => ['pages', 'tools'], 'show' => ['comments']])),
    $keys(agentpress_push_op_editor_view([])),
];
echo 'OUT:' . base64_encode(json_encode([
    'steps' => $out,
    'bad_refused' => $bad instanceof WP_Error,
    'editor' => $editor,
    'editor_screens' => agentpress_push_editor_blocked_screens(agentpress_push_editor_hidden()),
    'editor_refused' => [
        agentpress_push_op_editor_view(['hide' => ['plugins']]) instanceof WP_Error,
        agentpress_push_op_editor_view(['hide' => ['tools'], 'show' => ['tools']]) instanceof WP_Error,
    ],
]));
