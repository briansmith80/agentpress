// patchOxygenHtmlToPage is the only place this tool edits code it does not own,
// so the guards matter more than the patch: every path must either act on an
// exactly-known string or refuse and say why. These tests pin the refusals,
// because a patcher that silently rewrites an unfamiliar vendor file is far
// worse than one that does nothing.
//
// No Laragon and no WordPress needed — the function is filesystem work plus one
// `php -r` probe, and the probe only runs once the string checks have passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchOxygenHtmlToPage } from '../src/plugins.mjs';

const REL = ['wp-content', 'plugins', 'oxygen', 'plugin', 'mcp', 'design'];
const BROKEN = `    $wrapped = '<meta charset="utf-8"><div id="__bdmcp_root__">' . $html . '</div>';\n`;
const FIXED = `    $wrapped = '<?xml encoding="utf-8"?><div id="__bdmcp_root__">' . $html . '</div>';\n`;

/** A throwaway site tree; pass null for `body` to omit Oxygen entirely. */
async function site(body) {
  const root = await mkdtemp(join(tmpdir(), 'ap-vendor-'));
  if (body !== null) {
    const dir = join(root, ...REL);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'html-to-page.php'), `<?php\n${body}`, 'utf8');
  }
  return root;
}

const fileIn = (root) => join(root, ...REL, 'html-to-page.php');
const exists = async (p) => stat(p).then(() => true, () => false);

test('patches the known-broken wrapper and keeps a backup', async () => {
  const root = await site(BROKEN);
  const res = await patchOxygenHtmlToPage({ path: root });

  // Skip rather than fail where PHP is unavailable (CI without Laragon): the guard
  // correctly declines when it cannot establish the libxml version.
  //
  // BOTH statuses, and that is the whole point of the pair. Until v1.8.0 an
  // unreadable libxml version was reported as `not-affected`, i.e. indistinguishable
  // from a genuinely old libxml that needs no patch; it is now `unknown-libxml` and
  // is reported to the user, because the silent version left people with an Oxygen
  // whose html-to-page fails on every input and nothing on screen explaining why.
  // This test only exercises the patch itself, so it stands down for either.
  if (res.status === 'unknown-libxml' || res.status === 'not-affected') return;

  assert.equal(res.status, 'patched');
  const after = await readFile(fileIn(root), 'utf8');
  assert.ok(after.includes(`'<?xml encoding="utf-8"?><div id="__bdmcp_root__">'`), 'wrapper replaced');
  assert.ok(!after.includes('<meta charset="utf-8"><div'), 'broken wrapper gone');
  assert.ok(after.includes('PATCHED BY AGENTPRESS'), 'records who changed it and why');
  assert.ok(await exists(`${fileIn(root)}.agentpress-bak`), 'original preserved');
  assert.equal(await readFile(`${fileIn(root)}.agentpress-bak`, 'utf8'), `<?php\n${BROKEN}`);
});

test('is idempotent — an already-patched file is left alone', async () => {
  const root = await site(FIXED);
  const before = await readFile(fileIn(root), 'utf8');
  const res = await patchOxygenHtmlToPage({ path: root });
  assert.equal(res.status, 'already-patched');
  assert.equal(await readFile(fileIn(root), 'utf8'), before, 'file untouched');
  assert.equal(await exists(`${fileIn(root)}.agentpress-bak`), false, 'no pointless backup');
});

test('REFUSES a vendor file it does not recognise, and reports it', async () => {
  // The important one. If Oxygen rewrites this line, guessing at a fix could
  // corrupt a paid plugin — so the only safe move is to stop and be audible.
  const changed = `    $wrapped = '<meta charset="utf-8"><section id="__bdmcp_root__">' . $html . '</section>';\n`;
  const root = await site(changed);
  const said = [];
  const res = await patchOxygenHtmlToPage({ path: root, onStep: (m) => said.push(m) });

  assert.equal(res.status, 'unrecognised');
  assert.equal(await readFile(fileIn(root), 'utf8'), `<?php\n${changed}`, 'left byte-identical');
  assert.equal(said.length, 1, 'says something rather than passing silently');
  assert.match(said[0], /leaving it alone/i);
});

test('says nothing at all when Oxygen is not installed', async () => {
  const root = await site(null);
  const said = [];
  const res = await patchOxygenHtmlToPage({ path: root, onStep: (m) => said.push(m) });
  assert.equal(res.status, 'absent');
  assert.deepEqual(said, [], 'a site without Oxygen is not worth a line of output');
});

test('never throws — a scaffold is not worth failing over a builder tool', async () => {
  // A directory where the file should be: readFile rejects with EISDIR.
  const root = await mkdtemp(join(tmpdir(), 'ap-vendor-'));
  await mkdir(join(root, ...REL, 'html-to-page.php'), { recursive: true });
  await assert.doesNotReject(() => patchOxygenHtmlToPage({ path: root }));
});
