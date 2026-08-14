// The scaffold lock's failure modes, pinned. Both "regression:" cases were
// OBSERVED live while forcing contention (recorded across several handoffs as
// found-not-fixed): a scaffold once proceeded past a lock naming a live
// foreign pid, and once past a DIRECTORY sitting at the lock path. The lock
// guards against concurrent scaffolds racing Laragon reloads, so a stolen
// lock recreates exactly the hazard it exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireScaffoldLock } from '../src/engine.js';

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'agentpress-lock-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('acquires, writes pid+start, and release removes the file', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'lock.json');
    const release = await acquireScaffoldLock({ lockPath });
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(lock.pid, process.pid);
    assert.ok(lock.startedAt);
    await release();
    await assert.rejects(() => stat(lockPath), /ENOENT/);
  });
});

test('regression: a lock held by a LIVE pid is refused, never stolen — whatever its age', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'lock.json');
    // pid 4 is the Windows System process: always alive, never ours —
    // kill(4, 0) yields EPERM, which means EXISTS. This is the exact shape
    // of the observed steal. The ancient startedAt is the point: age alone
    // must not override a live pid (scaffolds legitimately stall for long
    // stretches on unattended UAC prompts).
    await writeFile(lockPath, JSON.stringify({ pid: 4, startedAt: '2020-01-01T00:00:00.000Z' }), 'utf8');
    await assert.rejects(() => acquireScaffoldLock({ lockPath }), /Another scaffold appears to be running \(pid 4/);
    const untouched = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(untouched.pid, 4, 'the held lock must not be rewritten');
  });
});

test('regression: a DIRECTORY at the lock path is refused with a message naming it — never deleted', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'lock.json');
    await mkdir(lockPath);
    await writeFile(join(lockPath, 'keep.txt'), 'not ours', 'utf8');
    await assert.rejects(() => acquireScaffoldLock({ lockPath }), /directory sits at the scaffold lock path/i);
    assert.equal(await readFile(join(lockPath, 'keep.txt'), 'utf8'), 'not ours', 'the directory and its contents must survive');
  });
});

test('a lock whose pid is dead is stolen, with the acquisition succeeding', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'lock.json');
    // A pid from the far end of the range is overwhelmingly likely dead;
    // probe first so the test cannot flake on a real process.
    let deadPid = 4000000;
    for (; deadPid > 3999900; deadPid -= 1) {
      try {
        process.kill(deadPid, 0);
      } catch (err) {
        if (err.code !== 'EPERM') break;
      }
    }
    await writeFile(lockPath, JSON.stringify({ pid: deadPid, startedAt: '2020-01-01T00:00:00.000Z' }), 'utf8');
    const release = await acquireScaffoldLock({ lockPath });
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(lock.pid, process.pid, 'the dead lock is replaced by ours');
    await release();
  });
});

test('an unreadable lock is refused while fresh (a concurrent acquirer mid-write) and stolen once old', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, 'lock.json');
    await writeFile(lockPath, '{ not json', 'utf8');
    // Fresh: written milliseconds ago — the wx+write pair is not atomic, so
    // this is what a concurrent acquirer looks like from the outside.
    await assert.rejects(() => acquireScaffoldLock({ lockPath }), /Another scaffold appears to be running/);
    // Old: same content, but mtime pushed past the write window — debris.
    const { utimes } = await import('node:fs/promises');
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);
    const release = await acquireScaffoldLock({ lockPath });
    await release();
  });
});
