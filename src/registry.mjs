// The environments registry — deliberately at ~/.katalyst-laragon/ so it can
// never collide with the Docker original's ~/.katalystwp/. Kept a nullable
// `port` field for shape-compatibility with that registry even though sites
// here are hostname-addressed, not port-addressed.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KATALYST_HOME, REGISTRY_PATH } from './paths.mjs';

export async function loadState() {
  try {
    const state = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'));
    return Array.isArray(state.environments) ? state : { environments: [] };
  } catch {
    return { environments: [] };
  }
}

/** Best-effort — a failed write never breaks scaffolding. Atomic (temp + rename) so a crash mid-write can't corrupt the file. */
export async function saveState(state) {
  try {
    await mkdir(KATALYST_HOME, { recursive: true });
    const tmp = `${REGISTRY_PATH}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, REGISTRY_PATH);
  } catch {
    // best-effort
  }
}

/** Keyed on `dir` — an existing record is shallow-merged, not replaced, so callers can update just the fields they know about (e.g. `update` only touches `updatedAt`/`agents`). */
export async function recordEnvironment(env) {
  const state = await loadState();
  const i = state.environments.findIndex((e) => e.dir === env.dir);
  if (i === -1) state.environments.push(env);
  else state.environments[i] = { ...state.environments[i], ...env };
  await saveState(state);
}

async function dirExists(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Prunes entries whose directory no longer exists (deleted by hand) before returning — matches the original's behavior of self-healing the registry on every `list`. */
export async function listEnvironments() {
  const state = await loadState();
  const kept = [];
  for (const env of state.environments) {
    if (await dirExists(env.dir)) kept.push(env);
  }
  if (kept.length !== state.environments.length) {
    await saveState({ environments: kept });
  }
  return kept;
}

export async function forgetEnvironment(dir) {
  const state = await loadState();
  const kept = state.environments.filter((e) => e.dir !== dir);
  if (kept.length !== state.environments.length) {
    await saveState({ environments: kept });
  }
}

export function formatEnvironmentsTable(environments) {
  if (environments.length === 0) {
    return 'No environments yet. Create one with: npx create-katalyst-laragon <name>';
  }
  const rows = environments.map((e) => ({
    name: e.name,
    host: e.hostname || '(unknown)',
    agents: (e.agents && e.agents.length ? e.agents.join(',') : 'none'),
    dir: e.dir,
  }));
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    host: Math.max(4, ...rows.map((r) => r.host.length)),
    agents: Math.max(6, ...rows.map((r) => r.agents.length)),
  };
  const header = `  ${'NAME'.padEnd(widths.name)}  ${'HOST'.padEnd(widths.host)}  ${'AGENTS'.padEnd(widths.agents)}  DIR`;
  const lines = rows.map(
    (r) => `  ${r.name.padEnd(widths.name)}  ${r.host.padEnd(widths.host)}  ${r.agents.padEnd(widths.agents)}  ${r.dir}`,
  );
  return [`Environments (${REGISTRY_PATH}):`, '', header, ...lines].join('\n');
}
