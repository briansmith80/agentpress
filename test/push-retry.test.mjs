// What happens when the line between the two sites is bad (review, 2026-11-11).
//
// request() retries a lost reply, which is only safe if the second attempt
// cannot DO the thing a second time. Three places it could: a download whose
// body died after its headers arrived (thrown past the retry loop), a one-shot
// step retried bare (an undo is a swap, so twice is "nothing happened",
// reported as done), and a retry that arrives while the first attempt is still
// running (the kept reply does not exist yet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remoteEndpoint, PLUGIN_FILE, PLUGIN_SLUG } from '../src/push.mjs';

const PLUGIN_PATH = fileURLToPath(new URL(`../src/push/${PLUGIN_SLUG}/${PLUGIN_FILE}`, import.meta.url));
const KEY = 'a'.repeat(48);

test('a download that is cut off after its headers arrived is asked for again', async () => {
  const whole = Buffer.from('0123456789');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const headers = { 'x-agentpress-total': String(whole.length) };
    if (calls === 1) {
      // Headers fine, then the connection dies two bytes in.
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(whole.subarray(0, 2));
          controller.error(new Error('socket hang up'));
        },
      });
      return new Response(body, { status: 200, headers });
    }
    return new Response(whole, { status: 200, headers });
  };
  const dir = await mkdtemp(join(tmpdir(), 'agentpress-retry-'));
  try {
    const file = join(dir, 'out.bin');
    await remoteEndpoint({ url: 'https://live.example', key: KEY }, { fetchImpl }).getFile('s', 'dump.sql', file);
    assert.equal(calls, 2, 'the first attempt was retried, not fatal');
    assert.deepEqual(await readFile(file), whole, 'and the file holds the whole download, once');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the steps that must not happen twice are sent so a retry is answered, not run', async () => {
  const src = (await readFile(new URL('../src/push.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  // Dry runs change nothing, so they may stay bare.
  const bare = [...src.matchAll(/\.run\('(db_swap|db_undo|design_apply|design_undo)'([^)]*)\)/g)].filter((m) => !/dry: true/.test(m[2]));
  // The one bare call left is `pull undo` on the local end: wp-cli on this machine, nothing in between to lose a reply.
  assert.deepEqual(bare.map((m) => m[0]), [".run('db_undo')"]);
  for (const op of ['db_swap', 'db_undo', 'design_apply', 'design_undo']) assert.match(src, new RegExp(`runOnce\\((to|remote), '${op}'`), op);
  const once = src.slice(src.indexOf('async function runOnce('), src.indexOf('\n}\n', src.indexOf('async function runOnce(')));
  assert.match(once, /seq: `\$\{randomBytes\(4\)\.toString\('hex'\)\}:0`/);
  assert.match(once, /session_new/);
});

test('the receiver takes a lock before it looks for a kept reply, and keeps it until the reply is written', async () => {
  const php = (await readFile(PLUGIN_PATH, 'utf8')).replace(/\r\n/g, '\n');
  const run = php.slice(php.indexOf('function agentpress_push_run('), php.indexOf("add_action('rest_api_init'"));
  const at = (needle) => {
    const i = run.indexOf(needle);
    assert.ok(i >= 0, `${needle} is in agentpress_push_run`);
    return i;
  };
  assert.ok(at('@flock($lock, LOCK_EX);') < at('$kept = is_file($memo)'), 'locked before the kept reply is read');
  assert.ok(at('call_user_func($ops[$op], $args)') < at('@file_put_contents($memo'), 'the reply is kept after the step ran');
  assert.ok(at('@file_put_contents($memo') < run.lastIndexOf('fclose($lock);'), 'and the lock is let go only after that');
  // A crash must not return early with the lock... it is released at process end anyway, but the reply path is one path.
  assert.doesNotMatch(run, /catch \(Throwable \$e\) \{\s*return /);
});

test('a path-only comparison does not read the files', async () => {
  const php = (await readFile(PLUGIN_PATH, 'utf8')).replace(/\r\n/g, '\n');
  assert.ok(php.includes("'h' => $hash ? sha1_file($abs) : ''"));
  const src = (await readFile(new URL('../src/push.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal((src.match(/'files_manifest', \{[^}]*\}/g) ?? []).filter((c) => /\bhash\b/.test(c)).length, 4, 'all four listings say whether they need hashes');
});
