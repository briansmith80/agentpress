// Site-name validation and collision checking.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WWW_DIR, STAGING_DIR, REGISTRY_PATH } from './paths.mjs';
import { findVhostForProject, hostsHasEntry, inferHostnameSuffix } from './laragon.mjs';

const RESERVED = new Set(['con', 'prn', 'aux', 'nul']);
for (let i = 0; i <= 9; i += 1) {
  RESERVED.add(`com${i}`);
  RESERVED.add(`lpt${i}`);
}

/**
 * Lowercase letters/digits/hyphens only (DNS-label-safe — underscores are
 * invalid in hostnames even though NTFS allows them), no leading/trailing
 * hyphen, <= 40 chars, and not a reserved Windows device name.
 */
export function validateSiteName(name) {
  const errors = [];
  if (!name) {
    errors.push('A site name is required.');
    return errors;
  }
  if (name.length > 40) {
    errors.push('Name must be 40 characters or fewer.');
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    errors.push(
      'Name must be lowercase letters, digits, and hyphens only, and cannot start or end with a hyphen (this also keeps it a valid DNS label).',
    );
  }
  if (RESERVED.has(name.toLowerCase())) {
    errors.push(`"${name}" is a reserved Windows device name and cannot be used as a folder name.`);
  }
  return errors;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function registeredNames() {
  try {
    const state = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
    return Array.isArray(state.environments) ? state.environments.map((e) => e.name) : [];
  } catch {
    return [];
  }
}

/**
 * Six collision surfaces (a name can be "free" on some and taken on others —
 * the nasty case is a directory that's free but a DB or vhost that isn't):
 * the www\ directory, any vhost whose ROOT already resolves under it, a
 * hosts entry for the inferred hostname, the environments registry, and a
 * leftover staging directory. MySQL database collisions are checked
 * separately in Phase 3, once a DB connection is available.
 */
export async function findCollisions(name) {
  const collisions = [];
  const projectDir = join(WWW_DIR, name);
  const stagingDir = join(STAGING_DIR, name);

  if (await exists(projectDir)) {
    collisions.push(`A folder already exists at ${projectDir}`);
  }
  const vhost = await findVhostForProject(projectDir);
  if (vhost) {
    collisions.push(`A vhost already points under this project: ${vhost.file}`);
  }
  const { suffix } = await inferHostnameSuffix();
  const hostname = `${name}${suffix}`;
  if (await hostsHasEntry(hostname)) {
    collisions.push(`hosts already has an entry for ${hostname}`);
  }
  const registered = await registeredNames();
  if (registered.includes(name)) {
    collisions.push(`"${name}" is already in the katalyst-laragon registry`);
  }
  if (await exists(stagingDir)) {
    collisions.push(`A leftover staging directory exists at ${stagingDir} (from an interrupted run)`);
  }
  return { collisions, hostname, projectDir, stagingDir };
}
