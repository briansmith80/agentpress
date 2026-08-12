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
/**
 * Two escalating attempts. The second one is the part with evidence behind it; be
 * careful not to over-claim the first.
 *
 * WHAT WAS OBSERVED on a real teardown (a site folder is a WordPress install, ~2000
 * files, with VS Code and two PHP language servers indexing it): the recursive
 * delete failed with EBUSY, a RENAME of the same directory succeeded — so the
 * directory itself was never held, a child file was — and then deleting the
 * top-level entries ONE AT A TIME succeeded on every single one. That is why the
 * piecemeal fallback exists: it is the thing that demonstrably worked.
 *
 * WHAT IS NOT ESTABLISHED: that the previous 5 x 100ms budget was too short. A probe
 * holding a real exclusive handle for 900ms was survived by BOTH the old and the new
 * settings, because Node scales retryDelay per attempt (5 x 100ms is ~1.5s
 * cumulative, not 500ms). The larger budget is cheap insurance for a longer race,
 * not a diagnosed fix — do not cite it as one.
 *
 * Only a genuinely held handle survives both passes, and that is the case the caller
 * reports to the user.
 */
export async function removeDirSafely(dir) {
  await unlinkJunctionsRecursively(dir);
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    return;
  } catch (err) {
    if (!/EBUSY|EPERM|ENOTEMPTY/.test(err.code || '')) throw err;
  }
  // Piecemeal pass. Collect failures rather than stopping at the first, so one stuck
  // file cannot hide the rest, then let the final rm report what is genuinely left.
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    // vanished between attempts, which is a success
    return;
  }
  for (const name of entries) {
    await rm(join(dir, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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
