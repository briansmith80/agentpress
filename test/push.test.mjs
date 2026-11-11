// push / pull. Everything here runs with no Laragon, no WordPress and no
// network: the pure halves of src/push.mjs, plus the one PHP function whose
// failure is silent in production (a serialized option whose string lengths
// no longer add up reads back as `false`, and a site "loses its widgets").
//
// What this file CANNOT see is the thing that matters most - a real copy
// between two real sites - and it does not pretend to. That is the live run
// in CLAUDE.md ("Push and pull").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buildZip,
  chunkSizeFor,
  crc32,
  describeDesignPlan,
  diffManifests,
  isLocalHost,
  parseConnection,
  parseManifest,
  pluginZip,
  PushError,
  remoteEndpoint,
  runSteps,
  upsertEnv,
  withoutLocalOnlyPlugins,
  LOCAL_AGENT_PLUGINS,
  PLUGIN_FILE,
  PLUGIN_SLUG,
} from '../src/push.mjs';
import { runPhpCode } from '../src/wp.mjs';

const PLUGIN_PATH = fileURLToPath(new URL(`../src/push/${PLUGIN_SLUG}/${PLUGIN_FILE}`, import.meta.url));
const line = (data) => `agentpress-push:${Buffer.from(JSON.stringify(data)).toString('base64url')}`;
const KEY = 'a'.repeat(48);

test('parseConnection reads the line the plugin shows', () => {
  assert.deepEqual(parseConnection(line({ v: 1, url: 'https://example.co.za/', key: KEY })), { url: 'https://example.co.za', key: KEY });
});

test('parseConnection survives the whitespace a terminal paste adds', () => {
  const text = line({ v: 1, url: 'https://example.co.za', key: KEY });
  assert.equal(parseConnection(`  ${text.slice(0, 30)}\n${text.slice(30)}  `).key, KEY);
});

test('parseConnection refuses anything that is not a connection line, with a PushError', () => {
  for (const bad of ['', 'https://example.co.za', 'agentpress-push:', 'agentpress-push:!!!', line({ v: 2, url: 'https://x.test', key: KEY }), line({ v: 1, url: 'ftp://x.test', key: KEY }), line({ v: 1, url: 'https://x.test', key: 'short' })]) {
    assert.throws(() => parseConnection(bad), PushError, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('isLocalHost only exempts hosts that cannot leave the machine', () => {
  for (const host of ['spice.test', 'a.b.local', 'localhost', '127.0.0.1', 'x.localhost']) assert.equal(isLocalHost(host), true, host);
  for (const host of ['mymagazinehub.example', 'test.example.com', 'mytest', 'localhost.example.com']) assert.equal(isLocalHost(host), false, host);
});

test('upsertEnv replaces a key in place and leaves every other line alone', () => {
  const before = 'DB_NAME=site\r\nPUSH_REMOTE_URL=https://old.example\r\nSITE_HOST=site.test\r\n';
  const after = upsertEnv(before, { PUSH_REMOTE_URL: 'https://new.example', PUSH_REMOTE_KEY: KEY });
  assert.equal(after, `DB_NAME=site\r\nPUSH_REMOTE_URL=https://new.example\r\nSITE_HOST=site.test\r\nPUSH_REMOTE_KEY=${KEY}\r\n`);
});

test('upsertEnv does not treat a longer key as a match, and can remove one', () => {
  const after = upsertEnv('PUSH_REMOTE_URL_OLD=x\n', { PUSH_REMOTE_URL: 'y' });
  assert.equal(after, 'PUSH_REMOTE_URL_OLD=x\nPUSH_REMOTE_URL=y\n');
  assert.equal(upsertEnv(after, { PUSH_REMOTE_URL: null }), 'PUSH_REMOTE_URL_OLD=x\n');
});

test('crc32 matches the published check value', () => {
  // "123456789" -> 0xCBF43926 is the standard CRC-32 test vector.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('buildZip writes an archive whose own tables describe its contents', () => {
  const data = Buffer.from('<?php // hello\n'.repeat(50));
  const zip = buildZip([{ name: 'agentpress-push/agentpress-push.php', data }]);
  // End record -> central directory -> local header -> the bytes, exactly the
  // walk an unzipper does. If any offset is wrong WordPress says "incompatible archive".
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 1);
  const central = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(central), 0x02014b50);
  const nameLength = zip.readUInt16LE(central + 28);
  assert.equal(zip.subarray(central + 46, central + 46 + nameLength).toString(), 'agentpress-push/agentpress-push.php');
  const local = zip.readUInt32LE(central + 42);
  assert.equal(zip.readUInt32LE(local), 0x04034b50);
  const packedSize = zip.readUInt32LE(local + 18);
  const start = local + 30 + zip.readUInt16LE(local + 26);
  const unpacked = inflateRawSync(zip.subarray(start, start + packedSize));
  assert.ok(unpacked.equals(data));
  assert.equal(zip.readUInt32LE(local + 14), crc32(data));
});

test('the plugin zip holds the plugin under its own folder', async () => {
  const zip = await pluginZip();
  assert.ok(zip.includes(Buffer.from(`${PLUGIN_SLUG}/${PLUGIN_FILE}`)));
});

test('diffManifests: mirror sends what is missing or different, and never asks to delete', () => {
  const source = parseManifest('{"p":"uploads/a.jpg","s":10,"h":"aa"}\n{"p":"uploads/b.jpg","s":20,"h":"bb"}\n{"p":"uploads/c.jpg","s":30,"h":"cc"}\n');
  const target = parseManifest('{"p":"uploads/a.jpg","s":10,"h":"aa"}\n{"p":"uploads/b.jpg","s":21,"h":"XX"}\n{"p":"uploads/editor.jpg","s":5,"h":"ee"}\n');
  const plan = diffManifests(source, target, 'mirror');
  assert.deepEqual(plan.send, ['uploads/b.jpg', 'uploads/c.jpg']);
  assert.equal(plan.bytes, 50);
  assert.deepEqual(plan.extra, ['uploads/editor.jpg']);
});

test('a push never sends the local agent plugins, and does not count them', () => {
  // These two carry shell-exec and PHP-eval abilities. On a dev machine that
  // is the product; on a public server it is a way in.
  const source = parseManifest(
    [
      '{"p":"plugins/oxygen/plugin.php","s":10,"h":"aa"}',
      '{"p":"plugins/agent-connector-for-wp/agent-connector.php","s":500,"h":"bb"}',
      '{"p":"plugins/universal-abilities-plugin/abilities/shell-exec.php","s":700,"h":"cc"}',
      // A lookalike name is NOT one of them and must still travel.
      '{"p":"plugins/agent-connector-for-wp-addon/x.php","s":3,"h":"dd"}',
      '{"p":"mu-plugins/agentpress-mcp-loopback-guard.php","s":4,"h":"ee"}',
    ].join('\n'),
  );
  const plan = diffManifests(withoutLocalOnlyPlugins(source), new Map(), 'mirror');
  assert.deepEqual(plan.send, ['plugins/oxygen/plugin.php', 'plugins/agent-connector-for-wp-addon/x.php', 'mu-plugins/agentpress-mcp-loopback-guard.php']);
  assert.equal(plan.bytes, 17);
  assert.deepEqual(LOCAL_AGENT_PLUGINS, ['agent-connector-for-wp', 'universal-abilities-plugin']);
});

test('the full push is the caller that asks for the agent plugins to stay behind', async () => {
  const src = await readFile(new URL('../src/push.mjs', import.meta.url), 'utf8');
  const full = src.slice(src.indexOf('async function pushFull'), src.indexOf('async function pushDesign'));
  // Both halves or neither: files skipped but the plugin left switched on in
  // the copied database is a fatal "plugin file does not exist" on live, and
  // the reverse ships the files for anyone to switch on later.
  assert.match(full, /skipLocalOnly: true/);
  assert.match(full, /drop_plugin_dirs: LOCAL_AGENT_PLUGINS/);
});

test("diffManifests: 'missing' never overwrites a file the target already has", () => {
  // The design push uses this for uploads: the editor's photo at the same
  // path as a local one must survive, because uploads belong to the live site.
  const source = parseManifest('{"p":"uploads/b.jpg","s":20,"h":"bb"}\n{"p":"uploads/c.jpg","s":30,"h":"cc"}\n');
  const target = parseManifest('{"p":"uploads/b.jpg","s":21,"h":"XX"}\n');
  assert.deepEqual(diffManifests(source, target, 'missing').send, ['uploads/c.jpg']);
});

test('chunkSizeFor stays under half the host limit, within sane bounds', () => {
  assert.equal(chunkSizeFor(8 * 1024 * 1024), 4 * 1024 * 1024);
  assert.equal(chunkSizeFor(2 * 1024 * 1024), 1024 * 1024);
  assert.equal(chunkSizeFor(100 * 1024), 256 * 1024); // floor: a tinier chunk is thousands of requests
  assert.equal(chunkSizeFor(0), 4 * 1024 * 1024); // "0" is how PHP spells unlimited
  assert.equal(chunkSizeFor(512 * 1024 * 1024), 4 * 1024 * 1024);
});

test('describeDesignPlan hides what does not change and names what does', () => {
  const lines = describeDesignPlan({
    changes: [
      { action: 'same', type: 'oxygen_block', title: 'Untouched', changed: [] },
      { action: 'adopt', type: 'oxygen_block', title: 'Matched only', changed: [] },
      { action: 'adopt', type: 'page', title: 'Home', changed: ['_oxygen_data'] },
      { action: 'create', type: 'oxygen_block', title: 'Brand new tile', changed: ['_oxygen_data'] },
      { action: 'update', type: 'oxygen_footer', title: 'Site Footer', changed: ['_oxygen_data'] },
      { action: 'bin', type: 'oxygen_block', title: 'Lead Story', changed: [] },
    ],
    site: { selectors: 'update', variables: 'same', front_page: 'none' },
  });
  assert.deepEqual(lines.map((l) => l.replace(/\s+/g, ' ')), [
    'match page Home',
    'new block Brand new tile',
    'change footer Site Footer',
    'remove block Lead Story',
    'change site selectors',
  ]);
});

test('runSteps hands each step the state the last one returned, with a step number', async () => {
  const seen = [];
  const endpoint = {
    label: 'fake',
    async run(_op, args) {
      seen.push(args);
      const n = (args.state?.n ?? 0) + 1;
      return { done: n === 3, state: { n } };
    },
  };
  const last = await runSteps(endpoint, 'db_import', { session: 'abc' });
  assert.equal(last.state.n, 3);
  assert.deepEqual(seen.map((a) => a.state), [undefined, { n: 1 }, { n: 2 }]);
  const seqs = seen.map((a) => a.seq);
  assert.equal(new Set(seqs).size, 3, 'every step is numbered differently');
  assert.ok(seqs.every((s) => s.startsWith(seqs[0].split(':')[0])), 'and all belong to one run');
});

test('the remote endpoint sends the key, and never follows a redirect with it', async () => {
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(body) });
  const endpoint = remoteEndpoint({ url: 'https://live.example', key: KEY }, { fetchImpl: async (url, init) => (calls.push({ url, init }), ok({ post_max_bytes: 8388608 })) });
  await endpoint.run('info');
  assert.equal(calls[0].init.headers['X-AgentPress-Key'], KEY);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.match(calls[0].url, /^https:\/\/live\.example\/\?rest_route=%2Fagentpress-push%2Fv1%2Frun&ap_n=[a-z0-9]+$/);

  const moved = remoteEndpoint({ url: 'https://live.example', key: KEY }, { fetchImpl: async () => ({ ok: false, status: 301, headers: new Map([['location', 'https://elsewhere.example/']]), text: async () => '' }) });
  await assert.rejects(() => moved.run('info'), (err) => err instanceof PushError && /redirected to https:\/\/elsewhere\.example/.test(err.message));
});

test('the remote endpoint turns a non-plugin answer into a message a person can act on', async () => {
  const html = remoteEndpoint({ url: 'https://live.example', key: KEY }, { fetchImpl: async () => ({ ok: false, status: 403, headers: new Map(), text: async () => '<html><body><h1>403 Forbidden</h1></body></html>' }) });
  await assert.rejects(() => html.run('info'), (err) => err instanceof PushError && /answered 403/.test(err.message) && /403 Forbidden/.test(err.message));
  const noRoute = remoteEndpoint({ url: 'https://live.example', key: KEY }, { fetchImpl: async () => ({ ok: false, status: 404, headers: new Map(), text: async () => JSON.stringify({ code: 'rest_no_route', message: 'No route', data: { status: 404 } }) }) });
  await assert.rejects(() => noRoute.run('info'), /not active on live\.example/);
});

test('the plugin header version and its version constant agree', async () => {
  const src = await readFile(PLUGIN_PATH, 'utf8');
  const header = /^\s*\*\s*Version:\s*(\S+)/m.exec(src)?.[1];
  const constant = /const AGENTPRESS_PUSH_VERSION = '([^']+)'/.exec(src)?.[1];
  assert.ok(header, 'plugin header has a Version');
  // Both ends compare this constant before a push; a header that drifted from
  // it would tell wp-admin one version and the push check another.
  assert.equal(header, constant);
});

test('the plugin keeps its connection key out of the database', async () => {
  const src = await readFile(PLUGIN_PATH, 'utf8');
  const keyCode = src.slice(src.indexOf('function agentpress_push_key_file'), src.indexOf('function agentpress_push_is_local_host'));
  // A full copy replaces wp_options underneath a running push. A key stored
  // there disappears at the table swap and every later step 401s, job half done.
  assert.doesNotMatch(keyCode, /update_option|add_option|get_option/);
  assert.match(keyCode, /hash\('sha256'/, 'only a hash of the key is stored');
});

/**
 * The plugin's URL replacement, run in real PHP with just enough of
 * WordPress stubbed for the file to load. Skipped, not failed, where PHP is
 * unavailable (CI has none) - the same escape vendor-patch.test.mjs takes.
 */
async function phpReplace(value, from, to) {
  const stub =
    "define('ABSPATH','/');define('MINUTE_IN_SECONDS',60);define('DAY_IN_SECONDS',86400);" +
    'function add_action(){} function untrailingslashit($s){return rtrim($s,"/\\\\");}' +
    'function is_serialized($d){return is_string($d)&&(bool)preg_match(\'/^([adObis]:|N;)/\',trim($d));}';
  const code = `${stub} require ${JSON.stringify(PLUGIN_PATH)}; $in = json_decode(base64_decode('${Buffer.from(JSON.stringify(value)).toString('base64')}'), true); echo 'OUT:' . base64_encode(json_encode(agentpress_push_replace_value($in, agentpress_push_url_pairs([${JSON.stringify(from)}], ${JSON.stringify(to)}))));`;
  // Skip ONLY when PHP itself is missing: no Laragon PHP folder (the resolver
  // throws, as on a CI runner) or the binary would not start (code null). PHP
  // that ran and answered wrongly is a FAILURE - a skip there would hide a
  // parse error in the plugin behind a green run, the same blind spot that put
  // six pushes on a red pipeline during 1.8.0.
  let res;
  try {
    res = await runPhpCode(code);
  } catch {
    return { skipped: true };
  }
  if (res.code === null) return { skipped: true };
  const match = /OUT:([A-Za-z0-9+/=]+)/.exec(res.stdout);
  assert.ok(res.code === 0 && match, `PHP ran but the plugin did not answer: ${res.stderr || res.stdout}`);
  return { value: JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) };
}

test('URL replacement keeps a PHP-serialized value readable when the address changes length', async (t) => {
  const from = 'https://mymagazinehub.test';
  const to = 'https://mymagazinehub.example';
  const inner = `a:2:{s:3:"url";s:${Buffer.byteLength(`${from}/wp-content/uploads/a.jpg`)}:"${from}/wp-content/uploads/a.jpg";s:4:"name";s:7:"Café A";}`;
  const res = await phpReplace(inner, from, to);
  if (res.skipped) return t.skip('PHP unavailable here');
  const expectedUrl = `${to}/wp-content/uploads/a.jpg`;
  assert.equal(res.value, `a:2:{s:3:"url";s:${Buffer.byteLength(expectedUrl)}:"${expectedUrl}";s:4:"name";s:7:"Café A";}`);
});

test('URL replacement covers http, JSON-escaped and URL-encoded spellings, and leaves the rest alone', async (t) => {
  const from = 'https://mymagazinehub.test';
  const to = 'https://mymagazinehub.example';
  const res = await phpReplace('a http://mymagazinehub.test/x b https:\\/\\/mymagazinehub.test\\/y c https%3A%2F%2Fmymagazinehub.test%2Fz d editor@mymagazinehub.test', from, to);
  if (res.skipped) return t.skip('PHP unavailable here');
  assert.equal(res.value, 'a https://mymagazinehub.example/x b https:\\/\\/mymagazinehub.example\\/y c https%3A%2F%2Fmymagazinehub.example%2Fz d editor@mymagazinehub.test');
});

test('URL replacement never builds an object out of data that arrived over the network', async (t) => {
  // A serialized object stays exactly as it was: unserialize() runs with
  // allowed_classes=false, so nothing named by the data is ever instantiated.
  const value = 'O:8:"stdClass":1:{s:1:"u";s:26:"https://mymagazinehub.test";}';
  const res = await phpReplace(value, 'https://mymagazinehub.test', 'https://mymagazinehub.example');
  if (res.skipped) return t.skip('PHP unavailable here');
  assert.equal(res.value, value);
});

/** The plugin's "does this path travel?" rule, run in real PHP. Same skip-only-when-PHP-is-missing rule as phpReplace. */
async function phpSkipped(paths) {
  const stub =
    "define('ABSPATH','/');define('MINUTE_IN_SECONDS',60);define('DAY_IN_SECONDS',86400);" +
    'function add_action(){} function untrailingslashit($s){return rtrim($s,"/\\\\");}';
  const code = `${stub} require ${JSON.stringify(PLUGIN_PATH)}; $in = json_decode(base64_decode('${Buffer.from(JSON.stringify(paths)).toString('base64')}'), true); $out = []; foreach ($in as $p) { $out[$p] = agentpress_push_path_skipped($p); } echo 'OUT:' . base64_encode(json_encode($out));`;
  let res;
  try {
    res = await runPhpCode(code);
  } catch {
    return { skipped: true };
  }
  if (res.code === null) return { skipped: true };
  const match = /OUT:([A-Za-z0-9+/=]+)/.exec(res.stdout);
  assert.ok(res.code === 0 && match, `PHP ran but the plugin did not answer: ${res.stderr || res.stdout}`);
  return { value: JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) };
}

test("plugin code is copied exactly: a folder's name never makes it disposable", async (t) => {
  // The first push to a real server died with
  //   Class "Breakdance\Lib\Vendor\Twig\Cache\FilesystemCache" not found
  // because any folder called "cache" was skipped, and that one is Oxygen's code.
  const mustTravel = [
    'plugins/oxygen/plugin/lib/mozart-scoped-psr4/Twig/Cache/FilesystemCache.php',
    'plugins/some-plugin/node_modules/lib/index.js',
    'plugins/some-plugin/backups/restore.php',
    'themes/mytheme/cache/compiled.css',
    'mu-plugins/tools/debug.log',
    'uploads/2026/11/photo.jpg',
    'uploads/oxygen/fonts/',
    'uploads/2026/cache/kept.jpg',
  ];
  const mustStay = [
    'plugins/agentpress-push/agentpress-push.php',
    'plugins/oxygen/.git/config',
    'uploads/cache/page.html',
    'uploads/ai1wm-backups/site.wpress',
    'uploads/backups/old.zip',
    'uploads/2026/11/debug.log',
    'uploads/2026/11/photo.jpg.ap-part',
  ];
  const res = await phpSkipped([...mustTravel, ...mustStay]);
  if (res.skipped) return t.skip('PHP unavailable here');
  for (const p of mustTravel) assert.equal(res.value[p], false, `${p} must travel`);
  for (const p of mustStay) assert.equal(res.value[p], true, `${p} must stay behind`);
});

test('empty folders travel too: listed, packed and created on the other end', async () => {
  // Oxygen checks that three of its upload folders EXIST. Listing files only
  // left them behind, and wp-admin on the live site said so.
  const src = await readFile(PLUGIN_PATH, 'utf8');
  assert.match(src, /RecursiveIteratorIterator::SELF_FIRST/, 'the listing must see folders, not just files');
  assert.match(src, /'h' => 'dir'/, 'an empty folder gets its own line in the file list');
  assert.match(src, /'d' => 1/, 'an empty folder gets its own record in the pack');
  assert.match(src, /wp_mkdir_p\(untrailingslashit\(\$abs\)\)/, 'the receiving end creates it');
});

test('an empty folder the target lacks is in the plan, and costs no bytes', () => {
  const source = parseManifest('{"p":"uploads/oxygen/fonts/","s":0,"h":"dir"}\n{"p":"uploads/oxygen/css/a.css","s":9,"h":"aa"}\n{"p":"uploads/oxygen/design_sets/","s":0,"h":"dir"}\n');
  const target = parseManifest('{"p":"uploads/oxygen/design_sets/","s":0,"h":"dir"}\n');
  const plan = diffManifests(source, target, 'mirror');
  assert.deepEqual(plan.send, ['uploads/oxygen/fonts/', 'uploads/oxygen/css/a.css']);
  assert.equal(plan.bytes, 9);
});

test("the server's page cache is purged when the content changes, with or without its plugin", async () => {
  // First real push: the home page stayed the empty pre-push WordPress
  // (X-LiteSpeed-Cache: hit), because the copied database had switched the
  // LiteSpeed Cache plugin off and nothing else knew how to clear it.
  const src = await readFile(PLUGIN_PATH, 'utf8');
  assert.match(src, /header\('X-LiteSpeed-Purge: \*'\)/, 'the web server is told directly, no plugin needed');
  for (const op of ['db_swap', 'db_undo', 'finish']) {
    const start = src.indexOf(`function agentpress_push_op_${op}(`);
    const body = src.slice(start, src.indexOf('\nfunction ', start + 10));
    assert.match(body, /agentpress_push_purge_page_cache\(\)/, `${op} must purge the page cache`);
  }
  // And a cache plugin the receiving site runs stays on, with its settings.
  assert.match(src, /array_keys\(agentpress_push_page_cache_plugins\(\)\)/, 'cache plugins are kept active through a swap');
  assert.match(src, /'litespeed-cache' => 'litespeed\.%'/);
});

test('no answer of ours can be kept or replayed by a page cache', async () => {
  // First real server: LiteSpeed stored a download and (1) answered a later,
  // different download at the same address with it, and (2) handed it to a
  // request that carried no key, since a cache hit never reaches the key check.
  const src = await readFile(PLUGIN_PATH, 'utf8');
  const start = src.indexOf('function agentpress_push_rest_permission(');
  const body = src.slice(start, src.indexOf('\nfunction ', start + 10));
  assert.match(body, /^[^\n]*\n\{\n\s*agentpress_push_never_cache\(\);/, 'never_cache runs before anything can be refused');
  assert.match(src, /header\('X-LiteSpeed-Cache-Control: no-cache'\)/);
  assert.match(src, /do_action\('litespeed_control_set_nocache'/);
  assert.match(src, /define\('DONOTCACHEPAGE', true\)/);

  // And the sender never asks for the same address twice.
  const urls = [];
  const endpoint = remoteEndpoint({ url: 'https://live.example', key: 'k' }, {
    fetchImpl: async (url) => (urls.push(String(url)), { ok: true, status: 200, headers: new Map(), text: async () => '{}' }),
  });
  await endpoint.run('info');
  await endpoint.run('info');
  await endpoint.run('files_manifest', { session: 's' });
  assert.equal(new Set(urls).size, urls.length, 'every request has its own address');
  assert.ok(urls.every((u) => new URL(u).searchParams.get('rest_route') === '/agentpress-push/v1/run'), 'the route itself is untouched');
});
