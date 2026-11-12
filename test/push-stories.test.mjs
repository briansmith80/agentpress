// `push content`: stories written on the dev site, sent up to live.
//
// The one way UP for content, so the rules it must keep are the ones that
// protect the editor: it only adds, it never writes over a story live already
// has unless it sent that story itself and nobody there touched it since, and
// it never writes over an upload. All of that was proven between two local
// sites on 2026-11-12 (see CLAUDE.md); these pin the pieces that proof rested
// on, and the two bugs the first run found.
//
// Two kinds of test, as in push-security: the PHP ones run the REAL plugin's
// text functions (test/php/stories-harness.php) and skip only when PHP is
// missing, which is the case on CI. The rest read the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describeStoryPlan, pickStories, LOCAL_STORY_OPTIONS, MENU_LABELS, PLUGIN_FILE, PLUGIN_SLUG } from '../src/push.mjs';
import { runPhpCode } from '../src/wp.mjs';

const PLUGIN_PATH = fileURLToPath(new URL(`../src/push/${PLUGIN_SLUG}/${PLUGIN_FILE}`, import.meta.url));
const HARNESS_PATH = fileURLToPath(new URL('./php/stories-harness.php', import.meta.url));
const read = async (rel) => (await readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')).replace(/\r\n/g, '\n');
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

const php = await read(`../src/push/${PLUGIN_SLUG}/${PLUGIN_FILE}`);
const js = await read('../src/push.mjs');
const body = (name) => {
  const start = php.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} exists`);
  return php.slice(start, php.indexOf('\nfunction ', start + 10));
};
const between = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `found ${from}`);
  return text.slice(start, text.indexOf(to, start + from.length));
};

/** Runs the harness. `skipped` only when PHP is missing: PHP that ran and answered wrongly must fail. */
async function harness(input) {
  const payload = Buffer.from(JSON.stringify({ plugin: PLUGIN_PATH, ...input })).toString('base64');
  let res;
  try {
    res = await runPhpCode(`$HARNESS = json_decode(base64_decode('${payload}'), true); require ${JSON.stringify(HARNESS_PATH)};`);
  } catch {
    return { skipped: true };
  }
  if (res.code === null) return { skipped: true };
  const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith('OUT:'));
  assert.ok(line, `the harness answered (exit ${res.code}): ${res.stdout.slice(0, 400)} ${res.stderr.slice(0, 400)}`);
  return JSON.parse(Buffer.from(line.slice(4), 'base64').toString('utf8'));
}

const CONTENT = [
  '<!-- wp:image {"id":151,"sizeSlug":"large"} -->',
  '<figure class="wp-block-image"><img src="x.jpg" class="wp-image-151"/></figure>',
  '<!-- /wp:image -->',
  '<!-- wp:gallery {"ids":[151, 152],"columns":2} -->',
  '<ul><li><img data-id="152" class="wp-image-152"/></li></ul>',
  '<!-- /wp:gallery -->',
  '<!-- wp:cover {"url":"y.jpg","id":153} --><div></div><!-- /wp:cover -->',
  '<!-- wp:media-text {"mediaId":154} --><div></div><!-- /wp:media-text -->',
  // Not media: another block's `id`, and a number that only looks like one.
  '<!-- wp:acme/widget {"id":151} /-->',
  '<!-- wp:block {"ref":151} /-->',
  '[caption id="attachment_155"]text[/caption] [gallery ids="151,156"]',
  '<p>Call 151 for details.</p>',
].join('\n');

test('the media numbers in a story are found where WordPress writes them, and only there', async (t) => {
  const out = await harness({ content: CONTENT, map: {}, rows: [], index: [], meta: [] });
  if (out.skipped) return t.skip('PHP unavailable here');
  assert.deepEqual([...out.ids].sort((a, b) => a - b), [151, 152, 153, 154, 155, 156]);
  assert.equal(out.untouched, CONTENT, 'with no numbers to swap the text is returned as it came');
});

test('each number is swapped for the receiving site\u2019s, and nothing else in the text moves', async (t) => {
  const out = await harness({ content: CONTENT, map: { 151: 9001, 152: 9002, 153: 9003, 154: 9004, 155: 9005, 156: 9006 }, rows: [], index: [], meta: [] });
  if (out.skipped) return t.skip('PHP unavailable here');
  const text = out.rewritten;
  for (const piece of ['{"id":9001,"sizeSlug":"large"}', 'wp-image-9001', '"ids":[9001,9002]', 'data-id="9002"', 'wp-image-9002', '"id":9003}', '"mediaId":9004', 'attachment_9005', 'ids="9001,9006"']) {
    assert.ok(text.includes(piece), `expected ${piece}`);
  }
  // A block that is not a media block keeps its own `id`: to it 151 is something else.
  assert.ok(text.includes('<!-- wp:acme/widget {"id":151} /-->'));
  assert.ok(text.includes('<!-- wp:block {"ref":151} /-->'));
  assert.ok(text.includes('Call 151 for details.'));
  // A number with no partner on the receiving site is left as it was, not zeroed.
  const partial = await harness({ content: CONTENT, map: { 152: 9002 }, rows: [], index: [], meta: [] });
  assert.ok(partial.rewritten.includes('wp-image-151') && partial.rewritten.includes('"ids":[151,9002]'));
});

test('a story here is "already on live" only when it is the same row there', async (t) => {
  const none = '0000-00-00 00:00:00';
  const index = [
    { id: 5, date_gmt: '2026-11-10 07:00:00', title: 'Renamed by the editor since' },
    { id: 153, date_gmt: '2026-11-12 08:00:00', title: 'Written on live' },
    { id: 154, date_gmt: none, title: 'A draft' },
    { id: 155, date_gmt: '2026-11-12 09:30:00', title: 'Published on live since the pull' },
  ];
  const rows = [
    [5, '2026-11-10 07:00:00', 'Its old title'], // same number, same publish time: the same story, whatever it is called now
    [153, '2026-11-12 11:49:27', 'Written here'], // the two sites count upwards from the same place, so numbers collide
    [154, none, 'A draft'], // a draft has no publish time: number and title
    [154, none, 'Another draft'],
    [155, none, 'Published on live since the pull'], // a draft here, published there
    [900, '2026-11-12 08:00:00', 'Written on live'], // same time and title, another number: not the same row
  ];
  const out = await harness({ content: '', map: {}, rows, index, meta: [] });
  if (out.skipped) return t.skip('PHP unavailable here');
  assert.deepEqual(out.same, [true, false, true, false, true, false]);
  // WordPress's own sample post is nobody's story, but only that exact one.
  assert.deepEqual(out.sample, [true, false, false]);
});

test('bookkeeping meta stays behind, a story\u2019s own meta travels', async (t) => {
  const keys = ['_edit_lock', '_edit_last', '_thumbnail_id', '_wp_old_slug', '_wp_trash_meta_status', '_agentpress_uid', '_agentpress_story_sent', '_oxygen_data', '_breakdance_data', '_yoast_wpseo_title', 'subtitle', '_wp_page_template'];
  const out = await harness({ content: '', map: {}, rows: [], index: [], meta: keys });
  if (out.skipped) return t.skip('PHP unavailable here');
  assert.deepEqual(out.left_behind, keys.slice(0, 9));
});

test('the plan numbers what will travel and says why the rest is left', () => {
  const { lines, sendable } = describeStoryPlan(
    [
      { uid: 'a', action: 'leave', reason: 'edited', title: 'Edited there' },
      { uid: 'b', action: 'create', status: 'publish', title: 'New one', images: 2, files: ['uploads/a.jpg', 'uploads/a-150x150.jpg'], notes: ['author:agent:admin'], new_terms: ['Food'] },
      { uid: 'c', action: 'update', status: 'draft', title: 'Changed', images: 0, files: [], notes: [], new_terms: [] },
      { uid: 'd', action: 'restore', status: 'future', title: 'Back from the bin', images: 0, files: [], notes: ['no_taxonomy:series'], new_terms: [] },
      { uid: 'e', action: 'leave', reason: 'image_clash', title: 'Clash', notes: ['photo.jpg'] },
      { uid: 'f', action: 'leave', reason: 'gone', title: 'Deleted there' },
      { uid: 'g', action: 'leave', reason: 'same_address', title: 'Twin' },
      { uid: 'h', action: 'leave', reason: 'on_live', title: 'Theirs' },
    ],
    'live.example',
  );
  assert.deepEqual(sendable.map((e) => e.uid), ['b', 'c', 'd'], 'in the order they are numbered');
  const text = lines.map(plain);
  // Two headings, like the design preview: what goes, then what is left.
  assert.deepEqual(text.slice(0, 2), ['', '  Stories to send to live.example']);
  assert.match(text[2], /^     1  add +New one +public, 2 images, 2 files to send$/);
  assert.ok(text.some((l) => /^ {17}makes the category or tag Food$/.test(l)), 'a note sits under the title it belongs to');
  assert.ok(text.some((l) => /^ {17}its author agent has no account on live\.example; it goes up as admin$/.test(l)));
  assert.ok(text.some((l) => /^     2  update +Changed +draft$/.test(l)));
  assert.ok(text.some((l) => /^     3  restore +Back from the bin +scheduled$/.test(l)));
  assert.ok(text.some((l) => /^ {17}live\.example has no "series" grouping, so that part is left off$/.test(l)));
  // Every story left alone has its reason in words, after the ones that travel.
  const heading = text.indexOf('  Left alone');
  assert.ok(heading > 0);
  const rest = text.slice(heading + 1);
  assert.match(rest[rest.length - 1], /^    everything else +this only adds: nothing on live\.example is replaced or deleted$/);
  const left = rest.slice(0, -1);
  assert.equal(left.length, 5);
  // The second column starts in one place on every row, sent or left.
  const second = (l) => l.indexOf(l.trim().split(/ {2,}/).pop());
  assert.equal(new Set(rest.map(second)).size, 1, 'reasons line up');
  assert.equal(second(rest[0]), second(text[2]), 'and start where the statuses above them do');
  assert.match(left.join('\n'), /edited on live\.example since it was sent/);
  assert.match(left.join('\n'), /live\.example has a different file called photo\.jpg/);
  assert.match(left.join('\n'), /deleted on live\.example after it was sent/);
  assert.match(left.join('\n'), /live\.example already has a story at that address/);
  assert.match(left.join('\n'), /live\.example has it as its own; change it there/);
  assert.ok(text.indexOf(left[0]) > text.findIndex((l) => l.startsWith('     3  ')));
});

test('the content plan never prints a heading with nothing under it, and never a row wider than the window', () => {
  // Nothing at all: no screen. Only stories left alone: one heading, no "everything else" row.
  assert.deepEqual(describeStoryPlan([], 'live.example').lines, []);
  const only = describeStoryPlan([{ uid: 'a', action: 'leave', reason: 'edited', title: 'Edited there' }], 'live.example').lines.map(plain);
  assert.deepEqual(only.slice(0, 2), ['', '  Left alone']);
  assert.equal(only.length, 3);
  const entries = [
    { uid: 'a', action: 'create', status: 'publish', title: 'A story whose headline runs on for quite a while longer than any column', images: 3, files: ['a', 'b', 'c'], notes: ['author:someone-with-a-long-login:admin'], new_terms: ['A long category name'] },
    { uid: 'b', action: 'leave', reason: 'same_address', title: 'Another long headline that also goes on and on and on' },
  ];
  for (const width of [40, 60, 100]) {
    for (const line of describeStoryPlan(entries, 'a-rather-long-host-name.example', width).lines.map(plain)) assert.ok(line.length <= width, `${width}: "${line}" is ${line.length} wide`);
  }
});

test('text from the other site cannot carry escape codes into the plan', () => {
  const { lines } = describeStoryPlan([{ uid: 'a', action: 'create', status: 'publish', title: 'Nice\u001b[2Jtitle', images: 0, files: [], notes: ['author:x\u001b[31m:admin'], new_terms: ['T\u0007ag'] }], 'live.example');
  // The helper colours with ESC[ itself when colour is on, so look for the hostile sequences, not for ESC.
  for (const line of lines) assert.ok(!line.includes('\u001b[2J') && !line.includes('\u0007') && !line.includes('x\u001b[31m'), JSON.stringify(line));
});

test('"send which?" takes all or numbers, and a typo sends nothing', () => {
  assert.deepEqual(pickStories('', 3), [0, 1, 2]);
  assert.deepEqual(pickStories(' ALL ', 3), [0, 1, 2]);
  assert.deepEqual(pickStories('3, 1', 3), [0, 2]);
  assert.deepEqual(pickStories('2 2', 3), [1]);
  for (const bad of ['n', 'no', 'none', '0', '4', '1,x', '1-3', 'y']) assert.equal(pickStories(bad, 3), null, bad);
});

test('the note on the dev site is written only after live says it has the story', () => {
  const send = between(js, 'async function pushStories', '\nasync function ');
  const plan = send.indexOf("'stories_import', { session: sessions.to, dry: true, draft }");
  const asked = send.indexOf('Send which?');
  const real = send.indexOf("runOnce(remote, 'stories_import'");
  const noted = send.indexOf("local.run('stories_mark', { sent: done.sent })");
  assert.ok(plan > 0 && plan < asked && asked < real && real < noted, 'plan, ask, send, then note');
  // The send is one step that must not happen twice (a retry after a lost reply).
  assert.ok(real > 0, 'the real send goes through runOnce');
  // A dry run writes nothing, the notes included: it asks with the index instead.
  assert.ok(send.includes('localInfo.stories_synced_with !== host && !dryRun'));
  assert.ok(between(js, 'async function storiesWaiting', '\n}').includes("remote.run('stories_index')"));
  // Sent files go in the ledger, or a design push would offer back one the editor deletes later.
  assert.ok(send.includes('await noteSeen(site, host, files)'));
});

test('a pull says which stories it would delete before it asks, and both copies level the notes', () => {
  const pull = between(js, 'export async function pullCommand', '\nexport async function pushCommand');
  const warn = pull.indexOf('a pull would delete');
  const refuse = pull.indexOf("if (!force) throw new PushError(`Send ");
  const ask = pull.indexOf("Replace this local site's content");
  assert.ok(warn > 0 && warn < refuse && refuse < ask);
  assert.ok(pull.indexOf("local.run('stories_level', { mark: host })") > pull.indexOf('copyDatabase('), 'after the copy, everything here is live\u2019s');
  const full = between(js, 'async function pushFull', '\nasync function pushDesign');
  assert.ok(full.indexOf("local.run('stories_level', { mark: host })") > full.indexOf('copyDatabase('));
  // Undoing a full copy puts live's earlier stories back, so those notes are taken again from its list.
  const undo = between(js, 'async function pushUndo', '\nexport async function pullCommand');
  assert.ok(undo.includes("reset: true"));
  // The note of WHICH live site stays with its own site through a database copy.
  assert.deepEqual(LOCAL_STORY_OPTIONS, ['agentpress_push_stories_synced']);
  assert.ok(php.includes("const AGENTPRESS_PUSH_STORIES_SYNCED = 'agentpress_push_stories_synced';"));
  assert.ok(js.includes('const OWN_OPTIONS = [...LOCAL_AGENT_OPTIONS, ...LOCAL_STORY_OPTIONS];'));
});

test('the receiver only writes to a story it made and nobody has touched', () => {
  const load = body('agentpress_push_op_stories_import');
  // update needs the kept fingerprint to still match; everything else found there is left.
  const edited = load.indexOf("agentpress_push_story_live_hash($target) !== $arrived");
  const update = load.indexOf("$entry['action'] = 'update';");
  assert.ok(edited > 0 && edited < update);
  assert.ok(load.includes("$entry['reason'] = 'on_live';") && load.includes("=== 'leave' ? 'binned' : ''") && load.includes("$entry['reason'] = 'gone';"));
  // Out of the bin only when OUR undo put it there.
  assert.ok(load.includes("get_post_meta($target, AGENTPRESS_PUSH_STORY_UNDONE, true) ? 'restore' : 'leave'"));
  // The plan is built again on the real run: `dry` returns before anything is written.
  assert.ok(load.indexOf("if ($dry) {") < load.indexOf('kses_remove_filters();'));
  assert.ok(load.indexOf('kses_remove_filters();') < load.indexOf('kses_init();'), 'the content filters are put back');
  // The same-address check asks the table: WP_Query hides a draft from a request with no login.
  assert.ok(load.includes("WHERE post_type = 'post' AND post_name = %s AND post_status IN ($in)"));
  // Meta arrives as stored text and is never turned into an object.
  assert.ok(load.includes("@unserialize($value, ['allowed_classes' => false])"));
  assert.ok(load.includes('count($items) > 50'));
});

test('an upload on the receiving site is never written over, and its library row gets a relative path', () => {
  const state = body('agentpress_push_story_media_state');
  assert.ok(state.includes("return ['state' => 'clash', 'id' => 0];"));
  assert.ok(state.includes('agentpress_push_runs_as_code($rel)'), 'a file that could run as code is not a picture');
  const load = body('agentpress_push_op_stories_import');
  // Only files that are not there are asked for.
  assert.ok(load.includes("} elseif (!is_file($abs)) {\n                            $state['need'][] = 'uploads/' . $file;"));
  // First local run: given the full path, the row kept `C:/...` and WordPress could not find the image.
  assert.ok(load.includes("]), (string) $media['file'], 0, true);"));
  assert.ok(!load.includes("$base . '/' . $media['file'], 0, true"));
  // stories.json has to be a name a session accepts, or the upload is refused before anything starts.
  assert.ok(body('agentpress_push_session_files').includes("'stories.json'"));
});

test('undo bins what it made, marks it, and the dev site forgets it was sent', () => {
  const undo = body('agentpress_push_op_stories_undo');
  assert.ok(undo.indexOf('update_post_meta($id, AGENTPRESS_PUSH_STORY_UNDONE') < undo.indexOf('wp_trash_post($id);'));
  assert.ok(!undo.includes('wp_delete_post'), 'the bin, never deleted');
  assert.ok(undo.includes("@rename($file, $file . '.undone');"), 'one send is undone once');
  const js_undo = between(js, 'async function pushUndo', '\nexport async function pullCommand');
  assert.ok(js_undo.includes("local.run('stories_mark', { unsent: res.uids ?? [], changed: res.reverted_uids ?? [] })"));
  // The id stays on the dev story, so sending it again finds the one in the bin instead of making a twin.
  const mark = body('agentpress_push_op_stories_mark');
  assert.equal(mark.split('delete_post_meta($id, AGENTPRESS_PUSH_UID)').length, 1);
});

test('the new commands are reachable: dispatch, flags, menu', async () => {
  assert.ok(js.includes("if (sub === 'content' || sub === 'stories' || sub === 'posts') return pushStories(site, { yes, dryRun, draft, positional });"));
  assert.ok(js.includes("if (sub === 'undo') return pushUndo(site, { full, content, yes });"));
  const engine = await read('../src/engine.js');
  assert.ok(engine.includes("draft: flagOn(args.flags.draft),") && engine.includes("content: flagOn(args.flags.content) || flagOn(args.flags.stories),"));
  assert.match(engine, /KNOWN_FLAGS = new Set\(\[[^\]]*'draft', 'content', 'stories'\]\)/);
  assert.equal(MENU_LABELS['push content'], 'Push content to live');
  assert.equal(MENU_LABELS['push undo --content'], 'Undo… → The last content push');
  for (const op of ['stories_index', 'stories_level', 'stories_export', 'stories_import', 'stories_undo', 'stories_mark']) {
    assert.ok(php.includes(`'${op}' => 'agentpress_push_op_${op}',`), op);
  }
});
