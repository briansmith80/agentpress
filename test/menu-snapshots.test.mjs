// The site menu's database snapshots: how a file is named, how the list is
// ordered, and what a failed save leaves behind. The menu is frozen into every
// site and imports nothing, so these RUN the real functions cut out of its
// source, against a temp folder. No Laragon, PHP or MySQL needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'template/scripts/agentpress.mjs'), 'utf8').replace(/\r\n/g, '\n');
const grab = (start) => {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${start} not found in the menu`);
  return src.slice(at, src.indexOf('\n}\n', at) + 3);
};
const line = (start) => {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${start} not found in the menu`);
  return src.slice(at, src.indexOf('\n', at) + 1);
};
const body = [
  line('const SNAPSHOT_STAMP = '),
  line('const MONTHS = '),
  grab('function snapshotName('),
  grab('function describeSnapshot('),
  grab('function listSnapshots('),
  grab('function snapshotWhen('),
  line('const KEPT_TABLE_PREFIXES = '),
  grab('async function keptTablesArg('),
  grab('async function takeSnapshot('),
].join('\n');
/** The menu's snapshot functions, pointed at `dir`, with `runWp` standing in for WP-CLI. */
const menuIn = (dir, runWp = async () => ({ code: 0, stdout: '', stderr: '' })) =>
  new Function(
    'readdirSync', 'statSync', 'existsSync', 'mkdirSync', 'writeFileSync', 'unlinkSync', 'join', 'SNAPSHOT_DIR', 'runWp',
    `${body}; return { snapshotName, describeSnapshot, listSnapshots, snapshotWhen, takeSnapshot };`,
  )(readdirSync, statSync, existsSync, mkdirSync, writeFileSync, unlinkSync, join, dir, runWp);
const temp = () => mkdtempSync(join(tmpdir(), 'ap-snap-'));

test('a snapshot is named by its time, with the note after it', () => {
  const { snapshotName } = menuIn(temp());
  const when = new Date('2026-11-12T13:48:10.730Z');
  assert.equal(snapshotName(when), 'db-2026-11-12T13-48-10-730Z.sql');
  assert.equal(snapshotName(when, 'Before footer change!'), 'db-2026-11-12T13-48-10-730Z_Before-footer-change.sql');
  assert.equal(snapshotName(when, '  ...  '), 'db-2026-11-12T13-48-10-730Z.sql', 'a note with nothing usable in it is no note');
});

test('nothing typed as a note can reach the shell or the mysql client', () => {
  // The path is quoted into a cmd.exe line for wp db export, and read back
  // inside a mysql SOURCE statement, where a backslash pair is a command.
  const { snapshotName } = menuIn(temp());
  const when = new Date('2026-11-12T13:48:10.730Z');
  for (const note of ['a" & del /q * & "', '%PATH% ^ | > x', '..\\..\\wp-config', 'né ünïcode ✓', 'x'.repeat(300), '-- ; DROP TABLE wp_posts']) {
    const name = snapshotName(when, note);
    assert.match(name, /^db-2026-11-12T13-48-10-730Z(_[A-Za-z0-9-]{1,40})?\.sql$/, `"${note}" became "${name}"`);
    assert.ok(!name.endsWith('-.sql') && !name.includes('_-'), `"${name}" has a stray hyphen at an edge`);
  }
});

test('a snapshot name gives back when it was taken and what for', () => {
  const { snapshotName, describeSnapshot } = menuIn(temp());
  const when = new Date('2026-11-12T13:48:10.730Z');
  const shot = describeSnapshot(snapshotName(when, 'before footer change'), 0);
  assert.equal(shot.at, when.getTime(), 'the time is the one in the name, not the file date');
  assert.equal(shot.note, 'before footer change');
  assert.equal(describeSnapshot(snapshotName(when), 0).note, '');
  // Named by hand: the file date is all there is, and the name says what it is.
  const hand = describeSnapshot('db-before-redesign-2026-11-11.sql', 1234);
  assert.deepEqual([hand.at, hand.note], [1234, 'db-before-redesign-2026-11-11']);
});

test('the list is newest first by time, where sorting the names picked the wrong file', () => {
  const dir = temp();
  try {
    const { snapshotName, listSnapshots } = menuIn(dir);
    const old = snapshotName(new Date('2026-11-10T20:18:10.730Z'));
    const newest = snapshotName(new Date('2026-11-12T09:00:00.000Z'), 'before the launch');
    const hand = 'db-before-redesign-2026-11-11.sql';
    writeFileSync(join(dir, old), 'a');
    writeFileSync(join(dir, newest), 'abc');
    writeFileSync(join(dir, hand), 'ab');
    const made = new Date('2026-11-11T07:38:00.000Z');
    utimesSync(join(dir, hand), made, made);
    // Not snapshots, or not safe to hand to a shell: none of these is offered.
    for (const other of ['.gitignore', 'notes.txt', 'my dump.sql', 'a&b.sql', 'db-x.sql.bak']) writeFileSync(join(dir, other), 'x');
    mkdirSync(join(dir, 'folder.sql'));

    const list = listSnapshots();
    assert.deepEqual(list.map((s) => s.name), [newest, hand, old]);
    assert.deepEqual(list.map((s) => s.bytes), [3, 2, 1]);
    assert.equal(list[0].note, 'before the launch');
    // What "Restore the latest snapshot" did before: sort the names, take the last.
    const byName = [old, newest, hand].sort().reverse()[0];
    assert.equal(byName, hand, 'a letter sorts after a digit, so the hand-named dump was offered as the latest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('names still sort oldest to newest, for a menu frozen before the list existed', () => {
  // A site that has not run `update` picks its latest by sorting names.
  const { snapshotName } = menuIn(temp());
  const times = ['2026-11-10T20:18:10.730Z', '2026-11-12T09:00:00.000Z', '2026-11-12T09:00:00.001Z', '2027-01-02T00:00:00.000Z'];
  const names = times.map((t, i) => snapshotName(new Date(t), ['zzz', '', 'aaa', 'mid'][i]));
  assert.deepEqual([...names].sort(), names);
  for (const name of names) assert.match(name, /^db-.*\.sql$/, 'the older menu only looks at db-*.sql');
});

test('no folder, no snapshots, no error', () => {
  assert.deepEqual(menuIn(join(temp(), 'not-there')).listSnapshots(), []);
});

test('every date in the list is the same width', () => {
  const { snapshotWhen } = menuIn(temp());
  for (const ms of [Date.UTC(2026, 0, 1, 3, 4), Date.UTC(2026, 10, 12, 13, 48), Date.UTC(2027, 11, 31, 23, 59)]) {
    assert.match(snapshotWhen(ms), /^\d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}$/);
  }
});

test('a saved snapshot is reported with its name and size, and the folder ignores itself', async () => {
  const dir = join(temp(), 'snapshots');
  const calls = [];
  const { takeSnapshot, listSnapshots } = menuIn(dir, async (args) => {
    if (args[1] === 'tables') return { code: 0, stdout: 'wp_options\nwp_posts\n', stderr: '' };
    calls.push(args);
    writeFileSync(args[2].replace(/"/g, ''), 'CREATE TABLE x;');
    return { code: 0, stdout: 'Success', stderr: '' };
  });
  const shot = await takeSnapshot('before restore');
  assert.equal(shot.ok, true);
  assert.match(shot.name, /^db-\d{4}-.*Z_before-restore\.sql$/);
  assert.equal(shot.bytes, 15);
  assert.equal(shot.left, 0);
  assert.deepEqual([calls[0][0], calls[0][1], calls[0][3]], ['db', 'export', '--add-drop-table']);
  assert.equal(calls[0].length, 4, 'nothing to leave out, so no exclude argument');
  assert.match(calls[0][2], /^"[^"\\]+"$/, 'the path is quoted and has no backslash for mysql to read as a command');
  // A dump is the whole site, password hashes included.
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(listSnapshots().map((s) => s.name), [shot.name]);
  rmSync(dirname(dir), { recursive: true, force: true });
});

test('a save that failed leaves no half-written dump to be offered as the newest', async () => {
  const dir = join(temp(), 'snapshots');
  const { takeSnapshot, listSnapshots } = menuIn(dir, async (args) => {
    if (args[1] === 'tables') return { code: 0, stdout: '', stderr: '' };
    writeFileSync(args[2].replace(/"/g, ''), 'DROP TABLE wp_posts;\nCREATE TABLE wp_po');
    return { code: 1, stdout: '', stderr: 'mysqldump: Got error: 2013: Lost connection\nmore' };
  });
  const shot = await takeSnapshot('x');
  assert.equal(shot.ok, false);
  assert.equal(shot.reason, 'mysqldump: Got error: 2013: Lost connection');
  assert.deepEqual(listSnapshots(), [], 'restoring half a dump drops every table and brings back some');
  // And when the tool never ran at all there is nothing to remove and nothing thrown.
  const never = await menuIn(dir, async () => ({ code: null, stdout: '', stderr: '' })).takeSnapshot();
  assert.deepEqual([never.ok, never.reason], [false, 'wp db export did not run']);
  rmSync(dirname(dir), { recursive: true, force: true });
});

test('a snapshot leaves out the tables a pull or full copy keeps for its undo', async () => {
  // They are not the site, they made one snapshot nine times the size of the
  // site, and restoring them wound a later pull's undo back.
  const exportsSeen = [];
  const tables = [
    'Deprecated: something PHP printed first',
    'wp_options',
    'wp_posts',
    'apold_wp_posts',
    'apold_AbC1_options',
    'apnew_wp_posts',
    'acfw_store_credits',
    'apoldish_table',
    'apold_x&calc',
    'apold_has space',
    '',
  ];
  const run = (list) => async (args) => {
    if (args[1] === 'tables') return list;
    exportsSeen.push(args);
    writeFileSync(args[2].replace(/"/g, ''), 'x');
    return { code: 0, stdout: '', stderr: '' };
  };
  const dir = join(temp(), 'snapshots');
  const shot = await menuIn(dir, run({ code: 0, stdout: tables.join('\r\n'), stderr: '' })).takeSnapshot();
  assert.equal(shot.left, 3);
  // Only plain names with one of the two prefixes: the list goes onto a shell line.
  assert.equal(exportsSeen[0][4], '--exclude_tables=apold_wp_posts,apold_AbC1_options,apnew_wp_posts');
  // The listing failed: the snapshot is taken whole, never skipped.
  const whole = await menuIn(dir, run({ code: 1, stdout: '', stderr: 'no' })).takeSnapshot();
  assert.deepEqual([whole.ok, whole.left, exportsSeen[1].length], [true, 0, 4]);
  // More kept tables than fit on a cmd.exe line: whole again.
  const many = Array.from({ length: 400 }, (_, i) => `apold_wp_table_number_${i}`).join('\n');
  const big = await menuIn(dir, run({ code: 0, stdout: many, stderr: '' })).takeSnapshot();
  assert.deepEqual([big.ok, big.left, exportsSeen[2].length], [true, 0, 4]);
  rmSync(dirname(dir), { recursive: true, force: true });
});

test('the menu knows the kept tables by the same prefixes the push plugin gives them', () => {
  const plugin = readFileSync(join(root, 'src/push/agentpress-push/agentpress-push.php'), 'utf8');
  const php = ['NEW', 'OLD'].map((name) => plugin.match(new RegExp(`const AGENTPRESS_PUSH_${name} = '([a-z_]+)';`))?.[1]);
  const menu = line('const KEPT_TABLE_PREFIXES = ').match(/\[(.*)\]/)[1].replace(/['\s]/g, '').split(',');
  assert.deepEqual(menu, php);
});

test('restoring saves the current database first, and stops if that fails', () => {
  // The order is the whole point: a restore was the one action in the menu
  // with no way back.
  const menu = grab('async function snapshotsMenu(');
  const save = menu.indexOf("await takeSnapshot('before restore')");
  const stop = menu.indexOf('if (!kept.ok)');
  const load = menu.indexOf("runWp(['db', 'import'");
  assert.ok(save >= 0 && stop > save && load > stop, 'save, check, then import');
  assert.match(menu.slice(stop, load), /continue;/, 'a failed save must not fall through to the import');
  // Back or Cancel is the first row of both choosers that can lose something.
  assert.match(menu, /const actions = \[\s*\{ value: 'back', label: 'Back' \}/);
  assert.match(menu, /const confirm = \[\s*\{ value: false, label: 'Cancel' \}/);
});
