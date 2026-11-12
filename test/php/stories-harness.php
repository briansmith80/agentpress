<?php
// Test harness, not shipped (package.json's `files` leaves test/ out).
//
// Loads the REAL plugin with the two things it touches at load time stubbed,
// and runs the parts of "send stories" that are pure text work: finding the
// media-library numbers a story points at, swapping them for the receiving
// site's, and deciding whether a story here is the same row as one on live.
// Those are the parts where a wrong answer is silent: a story that arrives
// showing someone else's picture, or one sent twice.
//
// In:  $HARNESS = ['plugin' => path, 'content' => string, 'map' => {old: new},
//                  'rows' => [[id, date_gmt, title], ...], 'index' => [...],
//                  'meta' => [keys]]
// Out: OUT:<base64 json>

define('ABSPATH', __DIR__ . '/');
function add_action()
{
}
function add_filter()
{
}
function register_activation_hook()
{
}

require $HARNESS['plugin'];

$map = [];
foreach ($HARNESS['map'] as $old => $new) {
    $map[(int) $old] = (int) $new;
}
$live = agentpress_push_story_live_map($HARNESS['index']);
$same = [];
foreach ($HARNESS['rows'] as $row) {
    $same[] = agentpress_push_story_same_row($row[0], $row[1], $row[2], $live);
}
$skipped = [];
foreach ($HARNESS['meta'] as $key) {
    if (agentpress_push_story_meta_skipped($key)) {
        $skipped[] = $key;
    }
}
echo 'OUT:' . base64_encode(json_encode([
    'ids' => agentpress_push_story_media_ids($HARNESS['content']),
    'rewritten' => agentpress_push_story_rewrite_ids($HARNESS['content'], $map),
    'untouched' => agentpress_push_story_rewrite_ids($HARNESS['content'], []),
    'same' => $same,
    'left_behind' => $skipped,
    'sample' => [agentpress_push_story_is_sample(1, 'hello-world'), agentpress_push_story_is_sample(1, 'my-first-story'), agentpress_push_story_is_sample(2, 'hello-world')],
]));
