// The security review of push / pull (2026-11-11), kept as tests.
//
// The finding that mattered: a PULL trusts the live site, and a live site is
// the end most likely to have been tampered with. Before these fixes a pack
// from live could carry `mu-plugins/evil.php` and it was unpacked into the
// developer's site, and a copied `upload_path` option could point the uploads
// folder anywhere on the developer's machine.
//
// Two kinds of test here. The PHP ones drive the REAL files_unpack against a
// fake wp-content (test/php/unpack-harness.php) and skip only when PHP is
// missing, which is the case on CI. The rest read the source for the call
// sites that must stay paired with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeDesignPlan, isLocalHost, parseConnection, PushError, remoteEndpoint, shown, upsertEnv, PLUGIN_FILE, PLUGIN_SLUG } from '../src/push.mjs';
import { runPhpCode } from '../src/wp.mjs';

const PLUGIN_PATH = fileURLToPath(new URL(`../src/push/${PLUGIN_SLUG}/${PLUGIN_FILE}`, import.meta.url));
const HARNESS_PATH = fileURLToPath(new URL('./php/unpack-harness.php', import.meta.url));
const line = (data) => `agentpress-push:${Buffer.from(JSON.stringify(data)).toString('base64url')}`;
const KEY = 'a'.repeat(48);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

test('a connection line cannot add lines to .env, and what is stored is the parsed address', () => {
  // The URL parser drops line breaks, so the first two passed every check
  // while the raw text, written as sent, added a line of its own to .env.
  const hostile = [
    'https://live.example/\nDB_NAME=other',
    'https://live.example/\r\nSITE_HOST=x.test',
    'https://live.example/\u001b[2J',
    'https://user:pw@live.example/',
    'https://live.example/?a=1',
    'https://live.example/#x',
  ];
  for (const url of hostile) assert.throws(() => parseConnection(line({ v: 1, url, key: KEY })), PushError, JSON.stringify(url));
  assert.deepEqual(parseConnection(line({ v: 1, url: 'HTTPS://Live.Example:443/sub/', key: KEY })), { url: 'https://live.example/sub', key: KEY });
  const { url } = parseConnection(line({ v: 1, url: 'https://live.example/', key: KEY }));
  assert.equal(upsertEnv('A=1\n', { PUSH_REMOTE_URL: url }).split('\n').filter(Boolean).length, 2, 'one line in, one line added');
});

test('the key is never sent over plain http to a host that is not this machine', () => {
  // Checked on every run, not only at connect: the address is read back from .env.
  assert.throws(() => remoteEndpoint({ url: 'http://live.example', key: KEY }), PushError);
  // .local is another device on the network.
  assert.equal(isLocalHost('nas.local'), false);
  assert.throws(() => remoteEndpoint({ url: 'http://nas.local', key: KEY }), PushError);
  assert.doesNotThrow(() => remoteEndpoint({ url: 'http://other-site.test', key: KEY }));
  assert.doesNotThrow(() => remoteEndpoint({ url: 'https://live.example', key: KEY }));
});

test('text from the other site cannot repaint the terminal', () => {
  assert.equal(shown('Home\u001b[2J\u001b[H fake plan\u009b31m'), 'Home[2J[H fake plan31m');
  assert.equal(shown(null), '');
  assert.equal(shown(12), '12');
  const lines = describeDesignPlan({ changes: [{ action: 'update', type: 'oxygen_footer', title: 'Foot\u001b[1Aer', changed: ['x'] }] });
  assert.ok(lines.length > 0);
  for (const l of lines) assert.doesNotMatch(l, CONTROL);
});

test('every unpack names its folders, and a pull keeps its own theme and takes no code', async () => {
  const src = (await readFile(new URL('../src/push.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const body = (name) => {
    const at = src.indexOf(name);
    assert.ok(at >= 0, `${name} is still in src/push.mjs`);
    return src.slice(at, src.indexOf('\n}\n', at));
  };
  const calls = src.match(/'files_unpack', \{[^}]*\}/g) ?? [];
  assert.equal(calls.length, 2, 'the two places that unpack');
  for (const call of calls) assert.match(call, /\broots\b/, `${call} says which folders the pack is for`);

  const pull = body('export async function pullCommand(');
  assert.match(pull, /keep_theme: true/);
  assert.match(pull, /copyFiles\(remote, local, sessions, work, \['uploads'\], 'mirror', \{ refuseCode: true \}\)/);
  // A push carries code on purpose, so it must NOT ask for code to be refused.
  assert.doesNotMatch(body('async function pushFull('), /refuseCode: true/);
  // Ctrl+C skips `finally`; without the handler a database export outlives the job on both ends.
  assert.match(body('async function withSessions('), /process\.once\('SIGINT', onStop\)/);
});

/** Drives the real files_unpack against a fake wp-content. `skipped` only when PHP is missing. */
async function phpUnpack(spec) {
  const dir = await mkdtemp(join(tmpdir(), 'agentpress-unpack-'));
  const input = { plugin: PLUGIN_PATH, base: dir, roots: null, refuse_code: false, uploads: null, ...spec };
  // `..` on purpose: what a copied upload_path of "../outside" turns into.
  if (spec.uploadsOutside) input.uploads = `${dir.replace(/\\/g, '/')}/site/wp-content/../outside`;
  const payload = Buffer.from(JSON.stringify(input)).toString('base64');
  try {
    let res;
    try {
      res = await runPhpCode(`$HARNESS = json_decode(base64_decode('${payload}'), true); require ${JSON.stringify(HARNESS_PATH)};`);
    } catch {
      return { skipped: true };
    }
    if (res.code === null) return { skipped: true };
    const match = /OUT:([A-Za-z0-9+/=]+)/.exec(res.stdout);
    assert.ok(res.code === 0 && match, `PHP ran but the harness did not answer: ${res.stderr || res.stdout}`);
    return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a pull unpacks pictures under uploads and nothing else the live site slips into the pack', async (t) => {
  // Before the fix this wrote mu-plugins/evil.php, uploads/shell.php and
  // uploads/.htaccess into the developer's site.
  const code = ['uploads/shell.php', 'uploads/shell.PHP', 'uploads/dot.php.', 'uploads/old.php5', 'uploads/x.phtml', 'uploads/a.phar', 'uploads/.htaccess', 'uploads/sub/.user.ini'];
  const elsewhere = ['mu-plugins/evil.php', 'plugins/x/x.php', 'themes/t/functions.php'];
  const out = await phpUnpack({ roots: ['uploads'], refuse_code: true, paths: ['uploads/2026/11/ok.jpg', 'uploads/notes.php.txt', ...code, ...elsewhere] });
  if (out.skipped) return t.skip('PHP unavailable here');
  assert.deepEqual(out.planted, ['wp-content/uploads/2026/11/ok.jpg', 'wp-content/uploads/notes.php.txt'], 'only the two harmless files landed');
  for (const p of code) assert.equal(out.results[p], 'refused', p);
  for (const p of elsewhere) assert.equal(out.results[p], 'error:bad_root', p);
});

test('a pack cannot replace the receiver, name it sideways, or arrive without saying what it is for', async (t) => {
  const sideways = ['plugins//agentpress-push/marker.txt', 'uploads/../escape.txt', 'uploads//x.txt', '/etc/x', 'uploads\\x.txt'];
  // Same folder to Windows, a different string to a prefix check.
  const windowsOnly = process.platform === 'win32' ? ['plugins/AgentPress-Push/marker.txt', 'uploads/shell.php::$DATA'] : [];
  const out = await phpUnpack({
    roots: ['plugins', 'mu-plugins', 'themes', 'uploads'],
    paths: ['mu-plugins/ok.php', 'uploads/code.php', 'plugins/agentpress-push/marker.txt', ...sideways, ...windowsOnly],
  });
  if (out.skipped) return t.skip('PHP unavailable here');
  assert.equal(out.receiver_intact, true, 'the running plugin is never overwritten');
  // A push may carry code: that is what a push is.
  assert.deepEqual(out.planted, ['wp-content/mu-plugins/ok.php', 'wp-content/uploads/code.php']);
  assert.equal(out.results['plugins/agentpress-push/marker.txt'], 'skipped');
  for (const p of sideways) assert.equal(out.results[p], 'error:bad_path', p);
  if (windowsOnly.length) {
    assert.equal(out.results['plugins/AgentPress-Push/marker.txt'], 'skipped');
    assert.equal(out.results['uploads/shell.php::$DATA'], 'error:bad_path');
  }

  const noRoots = await phpUnpack({ roots: null, paths: ['uploads/a.jpg'] });
  assert.equal(noRoots.results['uploads/a.jpg'], 'error:unpack_roots');
  assert.deepEqual(noRoots.planted, []);
});

test('an uploads folder that a copied database pointed outside wp-content is not written to', async (t) => {
  // WordPress builds the uploads folder from the upload_path option, and an
  // option arrives inside the copy. `../outside` stands for `../scripts` or a
  // Startup folder on the developer's machine.
  const out = await phpUnpack({ roots: ['uploads'], uploadsOutside: true, paths: ['uploads/run-me.bat', 'uploads/a.jpg'] });
  if (out.skipped) return t.skip('PHP unavailable here');
  assert.deepEqual(out.planted, [], 'nothing landed anywhere');
  for (const p of ['uploads/run-me.bat', 'uploads/a.jpg']) assert.equal(out.results[p], 'error:bad_root', p);
});

test('the receiver keeps its own upload path and (on a pull) theme, and only runs a table definition as SQL', async () => {
  const php = (await readFile(PLUGIN_PATH, 'utf8')).replace(/\r\n/g, '\n');
  assert.ok(php.includes("$own_names = ['upload_path', 'upload_url_path'];"));
  assert.ok(php.includes("if (!empty($args['keep_theme'])) {\n        $own_names = array_merge($own_names, ['template', 'stylesheet', 'current_theme']);"));
  // Anything other than one CREATE TABLE for the table the record names is refused, views included.
  assert.ok(php.includes("if (!preg_match('/^CREATE TABLE `\\{\\{P\\}\\}' . preg_quote((string) $record['name'], '/') . '` \\(/', (string) $record['create'])) {"));
  // Arriving data is never turned into objects.
  assert.doesNotMatch(php, /=\s*maybe_unserialize\(/);
  for (const call of php.match(/unserialize\([^;]*;/g) ?? []) {
    if (/^unserialize\(\$value\)|is_serialized/.test(call)) continue;
    assert.match(call, /'allowed_classes' => false/, call);
  }
  // A correct key is let in before the throttle is consulted, or anyone can lock the owner out.
  const perm = php.slice(php.indexOf('function agentpress_push_rest_permission('));
  assert.ok(perm.indexOf('hash_equals(') > 0 && perm.indexOf('hash_equals(') < perm.indexOf("'throttled'"), 'the key is compared before the throttle');
  // No key page where one site's admin is not the server's owner.
  assert.ok(php.includes("if (is_multisite() || !current_user_can('install_plugins')) {"));
});
