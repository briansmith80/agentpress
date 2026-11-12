// Three things the second day on the real server showed (2026-11-12), none
// visible between two local sites.
//
// 1. The default themes had been removed from live on purpose. They were
//    still in the local folder, so every design push offered all 393 files
//    back. A design push now sends only the theme the site runs on.
// 2. The whole site was behind the hosting panel's password lock. The server
//    answers 401 before WordPress runs, and the tool asked whether the plugin
//    was installed. It was.
// 3. The push plugin's own zip had been uploaded in the LOCAL wp-admin and the
//    screen left open. WordPress keeps such a zip as a media item until the
//    install ends, and the design push sent it to live as new media.
// 4. The first full copy onto that server after a pull took the local agent
//    connector's own tables and settings up with everything else, and the
//    undo left the tables there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { diffManifests, remoteEndpoint, withoutUnusedThemes, LOCAL_AGENT_OPTIONS, LOCAL_AGENT_TABLES, PLUGIN_FILE, PLUGIN_SLUG } from '../src/push.mjs';

const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const KEY = 'a'.repeat(48);

const local = () =>
  new Map([
    ['mu-plugins/sizes.php', { s: 10, h: 'a' }],
    ['themes/index.php', { s: 28, h: 'b' }],
    ['themes/twentytwentyfive/', { s: 0, h: 'dir' }],
    ['themes/twentytwentyfive/style.css', { s: 100, h: 'c' }],
    ['themes/child/', { s: 0, h: 'dir' }],
    ['themes/child/style.css', { s: 50, h: 'd' }],
    ['themes/parent/functions.php', { s: 70, h: 'e' }],
  ]);

test('a design push leaves out themes the site does not run on', () => {
  // Oxygen with themes off: nothing is in use, so no theme folder travels.
  const none = withoutUnusedThemes(local(), []);
  assert.deepEqual([...none.keys()], ['mu-plugins/sizes.php', 'themes/index.php']);

  // A child theme and its parent are both "in use"; the bundled default is not.
  const pair = withoutUnusedThemes(local(), ['child', 'parent']);
  assert.ok(pair.has('themes/child/style.css') && pair.has('themes/child/') && pair.has('themes/parent/functions.php'));
  assert.ok(!pair.has('themes/twentytwentyfive/style.css') && !pair.has('themes/twentytwentyfive/'));

  // Nothing else is touched, and a name that only STARTS like one in use is not let through.
  assert.ok(!withoutUnusedThemes(local(), ['twentytwenty']).has('themes/twentytwentyfive/style.css'));
  assert.ok(pair.has('mu-plugins/sizes.php'));
});

test('the files of an unused theme are not in the plan against a live site without it', () => {
  const live = new Map([['themes/index.php', { s: 28, h: 'b' }]]);
  const plan = diffManifests(withoutUnusedThemes(local(), []), live, 'mirror');
  assert.deepEqual(plan.send, ['mu-plugins/sizes.php']);
});

test('no answer about themes means the list is left as it is', () => {
  // An `info` without the field must not be read as "no theme in use".
  const list = local();
  assert.equal(withoutUnusedThemes(list, undefined), list);
});

test('the plugin reports the themes in use and the design push asks for them', async () => {
  const php = await read(`../src/push/${PLUGIN_SLUG}/${PLUGIN_FILE}`);
  assert.match(php, /'themes_in_use' =>/);
  // Only a name WordPress can find as a folder counts.
  assert.match(php, /is_dir\(get_theme_root\(\$slug\) \. '\/' \. \$slug\)/);
  const js = await read('../src/push.mjs');
  assert.match(js, /withoutUnusedThemes\(list, localInfo\.themes_in_use\)/);
  // A full copy is a copy: it must not be filtered.
  assert.doesNotMatch(js.slice(js.indexOf('async function pushFull'), js.indexOf('async function pushDesign')), /withoutUnusedThemes/);
});

test('the file list leaves out the zip WordPress keeps from an unfinished plugin upload', async () => {
  const php = await read(`../src/push/${PLUGIN_SLUG}/${PLUGIN_FILE}`);
  // Found by what WordPress itself marks them with, not by file type: a zip
  // an editor offers for download is media like any other.
  assert.match(php, /c\.meta_key = '_wp_attachment_context' AND c\.meta_value = 'upgrader'/);
  assert.match(php, /\$leftovers = \$root === 'uploads' \? agentpress_push_upgrader_leftovers\(\) : \[\];/);
  assert.match(php, /\$file->isFile\(\) && !isset\(\$leftovers\[\$rel\]\)/);
});

test('a site behind a password lock is named as that, not as a missing plugin', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response('<html><body><h1>401 Unauthorized</h1>Proper authorization is required</body></html>', {
      status: 401,
      headers: { 'content-type': 'text/html', 'www-authenticate': 'Basic realm="Access to the site"' },
    });
  };
  await assert.rejects(remoteEndpoint({ url: 'https://live.example', key: KEY }, { fetchImpl }).run('info'), (err) => {
    assert.match(err.message, /live\.example is behind a password lock/);
    assert.doesNotMatch(err.message, /Is the plugin installed/);
    return true;
  });
  assert.equal(calls, 1, 'a lock is not a lost reply: asking again changes nothing');
});

test('a 401 without the lock header still gets the old message', async () => {
  const fetchImpl = async () => new Response('<html>nope</html>', { status: 401, headers: { 'content-type': 'text/html' } });
  await assert.rejects(remoteEndpoint({ url: 'https://live.example', key: KEY }, { fetchImpl }).run('info'), /not AgentPress Push/);
});

test("the agent connector's tables and settings stay on the site they belong to, both ways", async () => {
  const js = await read('../src/push.mjs');
  const copy = js.slice(js.indexOf('async function copyDatabase'), js.indexOf('async function copyFiles'));
  // One function carries every database copy, push and pull, so naming them
  // here covers both directions. All three steps or the fix has a hole: not
  // read by the sender, refused by the receiver, settings put back at the switch.
  assert.ok(copy.includes("'db_export', { session: sessions.from, own_tables: LOCAL_AGENT_TABLES }"));
  assert.ok(copy.includes("'db_import', { session: sessions.to, own_tables: LOCAL_AGENT_TABLES }"));
  assert.ok(copy.includes("'db_swap', { ...swapArgs, own_option_prefixes: OWN_OPTIONS, session: sessions.to }"));
  // A table the receiver refused still counts, or an honest copy would fail the totals check.
  assert.ok(copy.includes('imported.rows + refusedRows !== exported.rows || imported.tables + refusedTables !== exported.tables'));

  const php = (await read(`../src/push/${PLUGIN_SLUG}/${PLUGIN_FILE}`)).replace(/\r\n/g, '\n');
  const body = (name) => {
    const start = php.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} exists`);
    return php.slice(start, php.indexOf('\nfunction ', start + 10));
  };
  assert.ok(body('agentpress_push_op_db_export').includes('!in_array(substr($table, strlen($prefix)), $own, true)'));
  const load = body('agentpress_push_op_db_import');
  const refuse = load.indexOf("$state['skip'] = in_array((string) $record['name'], $own_tables, true);");
  // The refusal comes before the table is created, and its rows are dropped, not loaded into the table before it.
  assert.ok(refuse > 0 && refuse < load.indexOf('$sql = str_replace('), 'refused before CREATE TABLE runs');
  assert.ok(load.indexOf("if ($state['skip'])") > 0 && load.indexOf("if ($state['skip'])") < load.indexOf('$row = [];'), 'rows of a refused table are dropped first');
  const swap = body('agentpress_push_op_db_swap');
  // Read BEFORE the rename (from the tables about to step aside), written after it.
  const kept = swap.indexOf('$install_rows[$row[');
  const rename = swap.indexOf("'RENAME TABLE '");
  const cleared = swap.indexOf('DELETE FROM {$wpdb->options} WHERE option_name LIKE %s');
  const back = swap.indexOf('foreach ($install_rows as $row)');
  assert.ok(kept > 0 && kept < rename, "this site's settings are read before the switch");
  assert.ok(rename < cleared && cleared < back, "the copy's rows go out before this site's come back");
});

test('the agent tables are whole names, so another plugin with the same prefix still travels', () => {
  // `acfw_` is also a WooCommerce coupons plugin's prefix. A pattern would leave a shop's tables behind.
  for (const name of LOCAL_AGENT_TABLES) assert.match(name, /^acfw_(oauth_(clients|codes|tokens)|mcp_events)$/);
  assert.ok(!LOCAL_AGENT_TABLES.includes('acfw_'));
  assert.deepEqual(LOCAL_AGENT_OPTIONS, ['agent_connector_for_wp_']);
});
