// The environments registry — deliberately at ~/.agentpress/ so it can
// never collide with the Docker original's ~/.katalystwp/. Kept a nullable
// `port` field for shape-compatibility with that registry even though sites
// here are hostname-addressed, not port-addressed.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { bold, dim, pink } from './ansi.mjs';
import { AGENTPRESS_HOME, REGISTRY_PATH } from './paths.mjs';

/**
 * Windows paths are case-insensitive but string compares aren't — scaffold
 * records `C:\laragon\www\x` while destroy/update use process.cwd(), which
 * preserves whatever casing the user typed (`c:\laragon\WWW\x`). Key
 * comparisons canonicalize; stored values keep their original casing for
 * display.
 */
function dirKey(p) {
  return resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
}

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
    await mkdir(AGENTPRESS_HOME, { recursive: true });
    const tmp = `${REGISTRY_PATH}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, REGISTRY_PATH);
  } catch {
    // best-effort
  }
}

/** Keyed on `dir` (case-insensitively) — an existing record is shallow-merged, not replaced, so callers can update just the fields they know about (e.g. `update` only touches `updatedAt`/`agents`). */
export async function recordEnvironment(env) {
  const state = await loadState();
  const i = state.environments.findIndex((e) => dirKey(e.dir) === dirKey(env.dir));
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
  const kept = state.environments.filter((e) => dirKey(e.dir) !== dirKey(dir));
  if (kept.length !== state.environments.length) {
    await saveState({ environments: kept });
  }
}

/**
 * `cli` is passed in rather than derived, mirroring `runDoctor({ cli })`: the
 * empty state used to hardcode "node index.js <name> (from the agentpress
 * checkout)", which is how a MAINTAINER runs it. Every documented route is
 * `npx create-agentpress@latest`, so the one message a brand-new user sees told
 * them to work from a checkout they have never made. Defaulted so existing
 * callers and tests keep working.
 */
export function formatEnvironmentsTable(environments, { cli = 'npx create-agentpress@latest', current = null, mcpTarget = null } = {}) {
  if (environments.length === 0) {
    return `No environments yet. Create one with:  ${pink(`${cli} <name>`)}`;
  }
  // Defensive fallbacks — a nameless entry (older format, hand-edited file)
  // used to crash the exact command whose prune self-heals the registry.
  const rows = environments.map((e) => ({
    // A leading marker for the site the agents actually point at. Wiring is
    // machine-global and the newest scaffold wins, so "which site am I talking to?"
    // is a real question that previously had no answer short of reading
    // ~/.claude.json by hand.
    mark: mcpTarget && String(e.hostname || '').toLowerCase() === String(mcpTarget).toLowerCase() ? '→' : ' ',
    name: e.name || basename(e.dir || '') || '(unknown)',
    host: e.hostname || '(unknown)',
    // `?` for sites recorded before this field existed, which is honest: the
    // registry genuinely does not know, and printing the running version there
    // would claim they are current when nobody has checked.
    version: e.version ? `v${e.version}` : '?',
    agents: e.agents && e.agents.length ? e.agents.join(',') : 'none',
    dir: e.dir || '(unknown)',
  }));
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    host: Math.max(4, ...rows.map((r) => r.host.length)),
    version: Math.max(7, ...rows.map((r) => r.version.length)),
    agents: Math.max(6, ...rows.map((r) => r.agents.length)),
  };
  // Padded RAW, then dimmed as one piece — ANSI escapes count toward
  // String.length, so per-cell colouring would eat the column alignment.
  const header = dim(`    ${'NAME'.padEnd(widths.name)}  ${'HOST'.padEnd(widths.host)}  ${'VERSION'.padEnd(widths.version)}  ${'AGENTS'.padEnd(widths.agents)}  DIR`);
  const lines = rows.map(
    (r) =>
      `  ${r.mark} ${r.name.padEnd(widths.name)}  ${r.host.padEnd(widths.host)}  ${r.version.padEnd(widths.version)}  ${r.agents.padEnd(widths.agents)}  ${r.dir}`,
  );
  // Counted separately, and neither is a guess. A recorded version that differs is
  // definitely behind; a '?' means the registry predates the field and genuinely
  // does not know — reporting it as behind would be inventing a fact, and staying
  // silent about it would hide the sites most likely to need the refresh.
  const behind = current ? rows.filter((r) => r.version !== '?' && r.version !== `v${current}`) : [];
  const unknown = rows.filter((r) => r.version === '?');
  const footer = [];
  // Only when a row actually carries the marker. The wired site may not be in the
  // registry at all, and a legend for a symbol that appears nowhere is noise.
  if (rows.some((r) => r.mark === '→')) footer.push('', dim(`  → = the site your agents' MCP connection points at`));
  if (current && (behind.length || unknown.length)) {
    const parts = [];
    if (behind.length) parts.push(`${behind.length} site${behind.length === 1 ? '' : 's'} not on v${current}`);
    if (unknown.length) parts.push(`${unknown.length} of unknown version`);
    footer.push(`  ${parts.join(', ')} — refresh with:  ${pink(`${cli} update --all`)}`);
  }
  return [`${bold('Environments')} ${dim(`(${REGISTRY_PATH})`)}`, '', header, ...lines, ...footer].join('\n');
}
