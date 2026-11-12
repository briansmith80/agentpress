// Two findings the core review (2026-11-11) listed and left open, closed the
// next day.
//
// 1. The check that the project root is not served over HTTP could not fail on
//    a machine that denies `.env` by name: Apache said 403 before it looked at
//    the folder, so the check passed with `.mcp.json` readable beside it.
// 2. Two plain-text files under public/ were readable by address: the backup
//    kept beside the patched Oxygen file, and wp-content/debug.log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRootServed } from '../src/engine.js';
import { HTACCESS_GUARD_BLOCK } from '../src/wordpress.mjs';

async function withProject(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agentpress-served-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a served project root is caught even when .env itself is denied by name', async () => {
  await withProject(async (dir) => {
    const asked = [];
    // A server that ignores the project .htaccess but refuses `.env` by name:
    // exactly the machine on which the old check could not fail.
    const fetchPath = async (path) => {
      asked.push(path);
      const file = path.split('/').pop();
      if (file === '.env') return { status: 403, body: 'Forbidden' };
      return { status: 200, body: await readFile(join(dir, file), 'utf8') };
    };
    assert.equal(await projectRootServed({ name: 'my-site', projectDir: dir, fetchPath }), true);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^\/my-site\/agentpress-root-probe-[0-9a-f]{8}\.txt$/);
    assert.deepEqual(await readdir(dir), [], 'the probe file is removed again');
  });
});

test('a denied project root passes, and the probe is still removed', async () => {
  await withProject(async (dir) => {
    assert.equal(await projectRootServed({ name: 'my-site', projectDir: dir, fetchPath: async () => ({ status: 403, body: 'Forbidden' }) }), false);
    assert.equal(await projectRootServed({ name: 'my-site', projectDir: dir, fetchPath: async () => null }), false);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('a page that answers 200 for anything is not mistaken for the probe', async () => {
  await withProject(async (dir) => {
    const fetchPath = async () => ({ status: 200, body: '<html><body>It works!</body></html>' });
    assert.equal(await projectRootServed({ name: 'my-site', projectDir: dir, fetchPath }), false);
  });
});

test('a probe that throws still leaves no file behind', async () => {
  await withProject(async (dir) => {
    await assert.rejects(
      projectRootServed({
        name: 'my-site',
        projectDir: dir,
        fetchPath: async () => {
          throw new Error('boom');
        },
      }),
      /boom/,
    );
    assert.deepEqual(await readdir(dir), []);
  });
});

test('the .htaccess block refuses the patch backup and the error log, and nothing else', () => {
  const line = HTACCESS_GUARD_BLOCK.split('\n').find((l) => l.startsWith('RewriteRule ') && l.includes('agentpress-bak'));
  assert.ok(line, 'the rule is in the block');
  const [, pattern, target, flags] = line.split(' ');
  assert.equal(target, '-');
  assert.equal(flags, '[F,L,NC]');
  // In a .htaccess the pattern is matched against the path WITHOUT its leading slash.
  const rule = new RegExp(pattern, 'i');
  for (const path of [
    'wp-content/debug.log',
    'debug.log',
    'wp-content/DEBUG.LOG',
    'wp-content/plugins/oxygen/plugin/mcp/design/html-to-page.php.agentpress-bak',
  ]) {
    assert.ok(rule.test(path), `${path} is refused`);
  }
  for (const path of [
    'hello-world/',
    'wp-json/wp/v2/posts',
    'wp-content/uploads/2026/11/photo.png',
    'wp-content/mydebug.log',
    'wp-content/debug.log.txt',
    'notes/agentpress-bak/readme.html',
    'index.php',
  ]) {
    assert.ok(!rule.test(path), `${path} is left alone`);
  }
});

test('the new rule cannot swallow the conditions meant for the agent-route rule', () => {
  // RewriteCond lines apply to the NEXT RewriteRule only. A rule dropped
  // between the conditions and their rule would take them and leave the
  // agent-route rule refusing every request.
  const lines = HTACCESS_GUARD_BLOCK.split('\n').filter((l) => /^Rewrite(Cond|Rule) /.test(l));
  const bak = lines.findIndex((l) => l.includes('agentpress-bak'));
  assert.equal(bak, 0, 'it is the first rewrite line, before any condition');
  assert.ok(lines[1].startsWith('RewriteCond '));
});
