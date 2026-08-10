// Directory junctions for the sibling-checkout → wp-content workflow
// (clone a plugin/theme next to the project, junction it into
// wp-content/plugins). Junctions, not symlinks: `fs.symlink(_, _,
// 'junction')` needs no elevation on this machine (Developer Mode is off,
// so `mklink /D` would need admin); junctions are directory-only and
// local-volume-only, which is exactly the shape this workflow needs.
import { lstat, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export async function createJunction(target, linkPath) {
  const absTarget = isAbsolute(target) ? target : resolve(target);
  await symlink(absTarget, linkPath, 'junction');
}

async function isJunctionOrSymlink(p) {
  try {
    const s = await lstat(p);
    return s.isSymbolicLink();
  } catch {
    return false;
  }
}

async function unlinkJunctionsRecursively(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (await isJunctionOrSymlink(full)) {
      await rm(full, { force: true }); // unlinks the link itself, never follows it
      continue;
    }
    const s = await lstat(full).catch(() => null);
    if (s?.isDirectory()) await unlinkJunctionsRecursively(full);
  }
}

/**
 * The one real data-loss risk in this whole workflow: `fs.rm(dir, {
 * recursive: true })` on a parent containing a junction can delete THROUGH
 * it and wipe the user's actual checkout, not just the link. Unlink every
 * junction/symlink anywhere in the tree FIRST, in its own pass, so the
 * final recursive removal has nothing left to (possibly) follow.
 */
export async function removeDirSafely(dir) {
  await unlinkJunctionsRecursively(dir);
  // Same retry options fsutil's rmWithRetry already uses. Without them a single
  // EBUSY/EPERM — an editor holding a file open, a virus scanner mid-pass, both
  // routine on Windows — aborted the teardown with a bare errno at the very last
  // step, after the database and vhost were already gone.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export async function listJunctions(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const junctions = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (await isJunctionOrSymlink(full)) {
      junctions.push({ path: full, target: await readlink(full).catch(() => null) });
    }
  }
  return junctions;
}
