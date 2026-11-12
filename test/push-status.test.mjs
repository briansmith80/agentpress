// `push status`, the progress bar and the pages lock (plugin 0.1.10).
//
// All three came from the operator's notes after two days on a real server
// (2026-11-12): status compared too little to explain why two sites that
// should match did not, a long transfer showed a byte count and no sense of
// how much was left, and the client's Editor account could edit pages the
// next design push would replace.
//
// The comparison and the bar are pure and tested as such. The lock is PHP: it
// runs the REAL plugin (test/php/pages-harness.php) and skips only when PHP is
// missing. PHP that ran and answered wrongly must fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePlugins, compareVersions, designChanges, designPlanScreen, editorViewScreen, pickSwitches, progressBar, LOCAL_AGENT_PLUGINS, MENU_LABELS, PLUGIN_FILE, PLUGIN_SLUG } from '../src/push.mjs';
import { runPhpCode } from '../src/wp.mjs';

const PLUGIN_PATH = fileURLToPath(new URL(`../src/push/${PLUGIN_SLUG}/${PLUGIN_FILE}`, import.meta.url));
const HARNESS_PATH = fileURLToPath(new URL('./php/pages-harness.php', import.meta.url));
const read = async (rel) => (await readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')).replace(/\r\n/g, '\n');
const php = await read(`../src/push/${PLUGIN_SLUG}/${PLUGIN_FILE}`);
const js = await read('../src/push.mjs');

const plugin = (dir, version, extra = {}) => ({ dir, name: dir, version, active: true, auto: false, update: '', ...extra });

test('versions compare by number, not by text, and say so when they cannot', () => {
  assert.equal(compareVersions('6.9', '6.10'), -1, '6.10 is newer than 6.9; as text it sorts first');
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
  assert.equal(compareVersions('3.1.4', '3.1.3'), 1);
  // "newer on live" printed for a guess would send someone to update the wrong end.
  assert.equal(compareVersions('6.2.0-beta.3', '6.2.0'), null);
  assert.equal(compareVersions('', '1.0'), null);
});

test('status lists only the plugins that differ, and which end is ahead', () => {
  const local = [plugin('oxygen', '6.2.0'), plugin('seo', '1.4.0'), plugin('forms', '2.0', { active: false }), plugin('only-here', '1.0')];
  const live = [plugin('oxygen', '6.2.0'), plugin('seo', '1.10.0', { auto: true }), plugin('forms', '2.0'), plugin('cache', '7.1', { update: '7.2' })];
  const out = comparePlugins(local, live);
  assert.deepEqual(
    out.rows.map((r) => [r.name, r.local, r.live, r.newer]),
    [
      ['cache', 'not installed', '7.1', null],
      ['forms', '2.0 (off)', '2.0', null],
      ['only-here', '1.0', 'not installed', null],
      ['seo', '1.4.0', '1.10.0', 'live'],
    ],
    'the matching plugin is left out; the rest are in a stable order',
  );
  assert.deepEqual(out.auto, ['seo'], 'the plugin live updates by itself is the one that drifts');
  assert.equal(out.waiting.length, 1);
  assert.match(out.waiting[0], /^cache 7\.1 .+ 7\.2$/);
});

test('status never reports the agent plugins or this tool as a difference', () => {
  // They are local-only on purpose. "Not installed on live" is the correct
  // state, and a line saying so reads as something to fix.
  const local = [...LOCAL_AGENT_PLUGINS.map((dir) => plugin(dir, '1.0')), plugin(PLUGIN_SLUG, '0.1.10')];
  const out = comparePlugins(local, [plugin(PLUGIN_SLUG, '0.1.9', { auto: true, update: '0.2' })]);
  assert.deepEqual(out, { rows: [], auto: [], waiting: [] });
  // An older plugin on the other end sends no list at all: nothing to say, not a crash.
  assert.deepEqual(comparePlugins(undefined, null), { rows: [], auto: [], waiting: [] });
});

test('the progress bar is a fixed width and clamps', () => {
  const half = progressBar(50, 100);
  assert.equal(half.full.length + half.empty.length, 18);
  assert.equal(half.full.length, 9);
  assert.equal(half.percent, ' 50%');
  assert.equal(progressBar(250, 100).percent, '100%', 'a sender that overshoots its own total is not 250%');
  assert.equal(progressBar(250, 100).empty, '');
  assert.equal(progressBar(-5, 100).full, '');
  // No total (the step has not counted yet): no bar, never a division by zero.
  assert.equal(progressBar(5, 0), null);
  assert.equal(progressBar(5, undefined), null);
  // Same width at every stage, or the numbers after it jump about.
  for (const done of [0, 1, 33, 99, 100]) {
    const bar = progressBar(done, 100);
    assert.equal(`${bar.full}${bar.empty} ${bar.percent}`.length, 23);
  }
});

test('every long transfer step reports progress the bar can draw', () => {
  // A bar needs done-and-total from the step. `update()` is for steps that have none.
  for (const step of ['db_export', 'db_import', 'files_manifest', 'files_pack', 'files_unpack']) {
    const at = js.indexOf(`'${step}'`);
    assert.ok(at > 0, `${step} is run`);
  }
  assert.ok((js.match(/tick\??\.progress\(/g) || []).length >= 8, 'the transfer steps draw a bar');
  assert.ok(!/tick\??\.update\(`[^`]* of /.test(js), 'a step that knows "x of y" draws the bar instead of only printing it');
  // The line is cut to the window before it is written: erase-line clears one row, not a wrapped one.
  const ticker = js.slice(js.indexOf('function ticker(text) {'), js.indexOf('async function confirm('));
  assert.ok(ticker.includes('process.stdout.columns'), 'the ticker reads the window width');
  assert.ok(!ticker.includes('.padEnd('), 'nothing coloured is padded');
});

test('the info a status reads is sent by the plugin under the names the command uses', () => {
  const info = php.slice(php.indexOf("'stories_unsent' => agentpress_push_stories_unsent()"), php.indexOf("'stories_unsent' => agentpress_push_stories_unsent()") + 700);
  for (const key of ['plugins', 'search_visible', 'memory_limit', 'upload_max_bytes', 'editor_hidden']) {
    assert.ok(info.includes(`'${key}' =>`), `info sends ${key}`);
    assert.ok(js.includes(`.${key}`), `status reads ${key}`);
  }
});

test('the pages switch is a file and the op is registered', () => {
  // A full copy replaces the options table. Kept there, the dev site's answer
  // would arrive on live inside the copy and open pages nobody opened.
  const fn = php.slice(php.indexOf('function agentpress_push_pages_open('), php.indexOf('function agentpress_push_lock_pages('));
  assert.ok(fn.includes('pages-access.txt'), 'the answer is kept in a file');
  assert.ok(!/get_option|update_option/.test(fn), 'not in the options table');
  assert.ok(php.includes("add_filter('user_has_cap', 'agentpress_push_lock_pages', 10, 1);"));
  assert.ok(php.includes("'pages_access' => 'agentpress_push_op_pages_access'"));
  assert.ok(MENU_LABELS['push editor'], 'the list has a menu item to name');
  assert.ok(php.includes("'editor_view' => 'agentpress_push_op_editor_view'"));
});

/** Runs the harness in an empty content folder. `skipped` only when PHP is missing. */
async function pages(siteUrl, steps) {
  const dir = await mkdtemp(join(tmpdir(), 'agentpress-pages-'));
  try {
    const payload = Buffer.from(JSON.stringify({ plugin: PLUGIN_PATH, content_dir: dir.replace(/\\/g, '/'), site_url: siteUrl, steps })).toString('base64');
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('on a public site pages start locked: an editor loses page editing and nothing else', async (t) => {
  const out = await pages('https://client.example', ['', 'open', 'locked']);
  if (out.skipped) return t.skip('PHP unavailable here');
  const [untouched, opened, locked] = out.steps;
  assert.equal(untouched.open, false, 'never chosen, public address: locked');
  assert.equal(untouched.chosen, false);
  assert.deepEqual(untouched.accounts.editor, { pages: 0, stories: 8, added: [] }, 'all nine page capabilities gone, every story one kept');
  assert.deepEqual(untouched.accounts.administrator, { pages: 9, stories: 8, added: [] }, 'an administrator is never locked out');
  assert.deepEqual(untouched.accounts.author, { pages: 0, stories: 6, added: [] }, 'a role with no page capabilities is handed none, not even false ones');
  assert.equal(opened.open, true);
  assert.equal(opened.chosen, true);
  assert.deepEqual(opened.accounts.editor, { pages: 9, stories: 8, added: [] }, 'opened on purpose: the editor has them back');
  assert.equal(locked.open, false, 'and locking again takes effect in the same request');
  assert.equal(locked.accounts.editor.pages, 0);
  assert.equal(out.bad_refused, true, 'only open and locked are states');
});

test('on a dev machine pages start open, and can still be locked', async (t) => {
  const out = await pages('https://my-site.test', ['', 'locked']);
  if (out.skipped) return t.skip('PHP unavailable here');
  assert.equal(out.steps[0].open, true, 'the only person on a .test site is the developer');
  assert.equal(out.steps[0].accounts.editor.pages, 9);
  assert.equal(out.steps[1].open, false);
  assert.equal(out.steps[1].accounts.editor.pages, 0);
});

// --- the design preview (operator, 2026-11-12: "looks like it can be laid out better") ---

const plainText = (lines) => lines.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''));

test('the design preview answers in three parts: what changes, what is sent, what is left alone', () => {
  const changes = designChanges({
    changes: [
      { action: 'update', type: 'oxygen_footer', title: 'Site Footer', changed: ['tree'] },
      { action: 'create', type: 'oxygen_template', title: 'Article page' },
      { action: 'bin', type: 'oxygen_block', title: 'Old promo' },
      { action: 'same', type: 'oxygen_header', title: 'Header' },
      { action: 'adopt', type: 'oxygen_block', title: 'Matched only', changed: [] },
    ],
    site: { global_settings: 'update', selectors: 'same' },
  });
  assert.deepEqual(changes, [
    ['change', 'footer', 'Site Footer'],
    ['new', 'template', 'Article page'],
    ['remove', 'block', 'Old promo'],
    ['change', 'site', 'global settings'],
  ]);
  const out = plainText(
    designPlanScreen({
      host: 'live.example',
      changes,
      code: ['mu-plugins/sizes.php'],
      media: { count: 2, bytes: 421888 },
      held: ['uploads/2026/11/a.jpg', 'uploads/2026/11/b.jpg', 'uploads/2026/11/c.jpg'],
      themes: { files: 393, names: ['twentytwentyfive', 'twentytwentyfour'] },
    }),
  );
  assert.deepEqual(out, [
    '',
    '  Changes on live.example',
    '    change   footer     Site Footer',
    '    new      template   Article page',
    '    remove   block      Old promo',
    '    change   site       global settings',
    '',
    '  Files to send',
    '    code     1 file     mu-plugins/sizes.php',
    '    media    2 files    412 KB, not on live.example yet',
    '',
    '  Left alone',
    '    media    3 files    deleted on live.example, so not sent back (uploads/2026/11/a.jpg, uploads/2026/11/b.jpg, …)',
    '    themes   393 files  in themes this site does not run on (twentytwentyfive, twentytwentyfour)',
    "    content             stories, users, comments and the editor's own uploads",
  ]);
});

test('the design preview shows no heading with nothing under it', () => {
  // Nothing to push at all: no screen. The caller prints its one green line.
  assert.deepEqual(designPlanScreen({ host: 'live.example' }), []);
  // Nothing to push, but files were held back: that is still worth saying,
  // without the "content" row, which only reassures beside a real plan.
  const held = plainText(designPlanScreen({ host: 'live.example', held: ['uploads/x.jpg'] }));
  assert.deepEqual(held, ['', '  Left alone', '    media    1 file     deleted on live.example, so not sent back (uploads/x.jpg)']);
  // Only a design change: no empty "Files to send".
  const only = plainText(designPlanScreen({ host: 'live.example', changes: [['change', 'footer', 'Footer']] }));
  assert.ok(!only.some((l) => l.includes('Files to send')));
  assert.ok(only.some((l) => l.includes('Left alone')));
});

test('no row of the design preview is wider than the window', () => {
  for (const width of [40, 60, 100]) {
    const out = plainText(
      designPlanScreen({
        host: 'a-rather-long-host-name.example',
        changes: [['change', 'template', 'A template with a very long name that goes on and on and on past any window']],
        code: ['mu-plugins/one.php', 'mu-plugins/two.php', 'themes/x/functions.php', 'themes/x/style.css'],
        media: { count: 12, bytes: 5 * 1024 * 1024 },
        held: ['uploads/2026/11/a-long-file-name.jpg', 'uploads/2026/11/another-long-file-name.jpg'],
        themes: { files: 393, names: ['twentytwentyfive'] },
        width,
      }),
    );
    for (const line of out) assert.ok(line.length <= width, `${width}: "${line}" is ${line.length} wide`);
  }
});

test('the design preview ends by naming the next step', () => {
  const fn = js.slice(js.indexOf('async function pushDesign('), js.indexOf('/** The compare half of copyFiles'));
  assert.ok(fn.includes("say(site, 'push')"), 'a preview says how to send it for real, as a menu item inside the menu');
  assert.ok(fn.includes('designPlanScreen('), 'the plan is drawn by the tested function');
  assert.ok(!fn.includes('this will:'), 'the one-table layout is gone');
});

// --- what editors see (plugin 0.1.11) ---

test('the editors list is numbered, lined up, and never wider than the window', () => {
  const items = [
    { key: 'pages', label: 'Pages', hidden: true },
    { key: 'comments', label: 'Comments', hidden: false },
    { key: 'tools', label: 'Tools', hidden: false },
    { key: 'news', label: 'WordPress news', hidden: true },
  ];
  const out = plainText(editorViewScreen(items, 'live.example'));
  assert.equal(out[1], '  What editors see on live.example');
  assert.match(out[2], /^     1  Pages           hidden  hidden = locked: only administrators edit pages$/);
  assert.match(out[3], /^     2  Comments        shown   /);
  assert.match(out[5], /^     4  WordPress news  hidden  /);
  for (const width of [40, 60, 100]) for (const line of plainText(editorViewScreen(items, 'a-rather-long-host-name.example', width))) assert.ok(line.length <= width, `${width}: "${line}"`);
  // A label from the other site is text, never escape codes.
  assert.ok(!editorViewScreen([{ key: 'x', label: 'Bad\u001b[2Jlabel', hidden: false }], 'h').join('').includes('\u001b[2J'));
});

test('"switch which?": Enter changes nothing, and a typo changes nothing', () => {
  // Unlike "send which?", where Enter means all. Here Enter-on-a-reflex would hide everything the client uses.
  assert.deepEqual(pickSwitches('', 4), []);
  assert.deepEqual(pickSwitches('  ', 4), []);
  assert.deepEqual(pickSwitches('2,3', 4), [1, 2]);
  for (const bad of ['all', 'a', 'y', '5', '0', '2-3', 'pages']) assert.equal(pickSwitches(bad, 4), null, bad);
});

test('the editors list only tidies people who are not administrators, and is a file', () => {
  const section = php.slice(php.indexOf('function agentpress_push_editor_items('), php.indexOf('function agentpress_push_op_editor_view('));
  assert.ok(section.includes("!current_user_can('manage_options')"), 'an administrator is never limited');
  for (const hook of ['agentpress_push_editor_menu', 'agentpress_push_editor_screens', 'agentpress_push_editor_toolbar', 'agentpress_push_editor_dashboard']) {
    const fn = section.slice(section.indexOf(`function ${hook}(`), section.indexOf('\n}\n', section.indexOf(`function ${hook}(`)));
    assert.ok(fn.includes('agentpress_push_editor_limited()'), `${hook} asks who is looking first`);
  }
  assert.ok(section.includes('editor-hidden.txt') && !/get_option|update_option/.test(section), 'kept in a file, not the options table a full copy replaces');
  // The command's notes cover exactly the plugin's list.
  const keys = [...section.slice(0, section.indexOf('}')).matchAll(/'([a-z]+)' => '/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['pages', 'comments', 'tools', 'news']);
  const notes = js.slice(js.indexOf('const EDITOR_NOTES = {'), js.indexOf('};', js.indexOf('const EDITOR_NOTES = {')));
  for (const key of keys) assert.ok(notes.includes(`${key}:`), `the command explains ${key}`);
});

test('hiding and showing through the real plugin: pages is the lock, the rest is a list that survives', async (t) => {
  const out = await pages('https://client.example', ['']);
  if (out.skipped) return t.skip('PHP unavailable here');
  const [start, hid, shown2, both, again] = out.editor;
  assert.deepEqual(start, ['pages'], 'a public site starts with Pages hidden and nothing else');
  assert.deepEqual(hid, ['pages', 'comments', 'news'], 'in the order the list is shown in, whatever order was asked');
  assert.deepEqual(shown2, ['comments', 'news'], 'showing Pages opens the lock');
  assert.deepEqual(both, ['pages', 'tools', 'news'], 'hide and show in one request');
  assert.deepEqual(again, ['pages', 'tools', 'news'], 'asking changes nothing');
  assert.deepEqual(out.editor_screens, ['tools.php', 'import.php', 'export.php', 'site-health.php', 'export-personal-data.php', 'erase-personal-data.php'], 'only the hidden entries have screens that send the person back');
  assert.deepEqual(out.editor_refused, [true, true], 'an unknown item, and the same item both ways, are refused');
});
