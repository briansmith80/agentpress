// Site-name validation and collision checking.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HOSTS_PATH, WWW_DIR, STAGING_DIR, REGISTRY_PATH } from './paths.mjs';
import { findVhostForHostname, findVhostForProject, hostsEntryAddresses, inferHostnameSuffix, isLoopbackAddress } from './laragon.mjs';

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
 * Six in-function collision surfaces (a name can be "free" on some and taken
 * on others — the nasty case is a directory that's free but a DB or vhost that
 * isn't): the www\ directory, any vhost whose ROOT already resolves under it,
 * a hosts entry pointing somewhere other than loopback, another project's
 * vhost already claiming the hostname, the environments registry, and a
 * leftover staging directory. MySQL database collisions are checked separately
 * in Phase 3, once a DB connection is available.
 *
 * A LOOPBACK hosts entry is deliberately NOT a collision. `destroy` leaves the
 * hosts line behind on purpose (this tool never deletes from hosts) and in
 * instant mode no Laragon reload ever prunes it, so treating any entry as a
 * collision permanently blocked re-using a destroyed site's name — with no
 * remedy printed, since the folder was gone and every hint was gated on it.
 * The entry is what a new scaffold would write anyway, so it is adopted.
 *
 * `kinds` reports WHICH surfaces fired, because the remedies differ sharply and
 * blanket advice is dangerous here: a leftover conf for this project should be
 * deleted, while another live project's conf must not be.
 */
export async function findCollisions(name) {
  const collisions = [];
  const kinds = {
    folder: false,
    vhostUnderProject: false,
    foreignHostsEntry: false,
    hostnameOwnedElsewhere: false,
    registry: false,
    staging: false,
  };
  const projectDir = join(WWW_DIR, name);
  const stagingDir = join(STAGING_DIR, name);

  if (await exists(projectDir)) {
    kinds.folder = true;
    collisions.push(`A folder already exists at ${projectDir}`);
  }
  const vhost = await findVhostForProject(projectDir);
  if (vhost) {
    kinds.vhostUnderProject = true;
    collisions.push(`A vhost already points under this project: ${vhost.file}`);
  }
  const { suffix } = await inferHostnameSuffix();
  const hostname = `${name}${suffix}`;
  const hostsAddresses = await hostsEntryAddresses(hostname);
  const foreignAddresses = hostsAddresses.filter((a) => !isLoopbackAddress(a));
  if (foreignAddresses.length) {
    kinds.foreignHostsEntry = true;
    collisions.push(
      `hosts maps ${hostname} to ${foreignAddresses.join(', ')} instead of 127.0.0.1, which would make\n` +
        `    the new site unreachable — remove that line from ${HOSTS_PATH} (as administrator) and retry`,
    );
  }
  // The condition the hosts check used to stand in for: another project's exact
  // vhost already serving this hostname. Apache matches vhosts first-match in
  // config order, so that conf would win over the wildcard and silently shadow
  // the new site. `vhost` above only finds confs rooted under THIS project.
  const hostnameOwner = await findVhostForHostname(hostname);
  if (hostnameOwner && (!vhost || hostnameOwner.file !== vhost.file)) {
    kinds.hostnameOwnedElsewhere = true;
    collisions.push(
      `${hostname} is already served by another project's vhost (${hostnameOwner.filename}` +
        `${hostnameOwner.root ? ` → ${hostnameOwner.root}` : ''}) — pick a different site name;` +
        ' do NOT delete that conf, it belongs to a different site',
    );
  }
  const registered = await registeredNames();
  if (registered.includes(name)) {
    kinds.registry = true;
    collisions.push(`"${name}" is already in the agentpress registry`);
  }
  if (await exists(stagingDir)) {
    kinds.staging = true;
    collisions.push(`A leftover staging directory exists at ${stagingDir} (from an interrupted run)`);
  }
  return { collisions, kinds, hostname, projectDir, stagingDir };
}
