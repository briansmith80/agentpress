// Plugin install/activate + the Agent Connector companion plugins. Ported
// policy from the Docker original — this layer never touched Docker
// directly (it always went through `wp` in the workspace container), so it
// carries over unchanged except for dropping the exec prefix.
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runWp, spawnCapture } from './wp.mjs';
import { PREMIUM_PLUGINS_DIR } from './paths.mjs';

// One release tag per plugin (mirrors the `universal-abilities-plugin`
// tag-per-asset pattern already used for AGENT_CONNECTOR_URL below) in a
// private repo of licensed zips — `gh` (already authenticated on this
// machine) refreshes the local cache from here so a zip dropped in on one
// machine doesn't need manually re-copying to every other one.
const PREMIUM_PLUGINS_REPO = process.env.KATALYST_PREMIUM_PLUGINS_REPO || 'briansmith80/oxygen-premium-plugins';

const AGENT_CONNECTOR_URL = 'https://github.com/soflyy/agent-connector-for-wp/releases/latest/download/agent-connector-for-wp.zip';
const UNIVERSAL_ABILITIES_URL =
  'https://github.com/soflyy/agent-connector-for-wp/releases/download/universal-abilities-plugin/universal-abilities-plugin.zip';

/**
 * Oxygen/Breakdance are commercial — not on wordpress.org, no stable public
 * download URL. Rather than hardcode any one user's Downloads path, this
 * looks in `~/.katalyst-laragon/premium-plugins/` for a zip matching each
 * slug (by filename prefix — vendor zips are named e.g.
 * `oxygen-6.2-beta.1.zip`, version-bumped over time) and picks the newest by
 * mtime if more than one is present. Drop a licensed zip in that folder once
 * and every scaffold picks it up; if it's missing, the plugin is skipped
 * with a clear message rather than failing the scaffold.
 */
const PREMIUM_PLUGINS = [
  { slug: 'oxygen', filePrefix: 'oxygen-' },
  { slug: 'breakdance-elements-for-oxygen', filePrefix: 'breakdance-elements-for-oxygen-' },
  { slug: 'breakdance-forms-for-oxygen', filePrefix: 'breakdance-forms-for-oxygen-' },
];

function fail(step, result) {
  throw new Error(`${step} failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim()}`);
}

/** `plugins` entries: a bare wordpress.org slug string, or `{ source, activate = true, version }` where `source` is a slug or a URL/path to a .zip. */
export async function installPlugins({ path, plugins = [], activate = [], onStep }) {
  for (const entry of plugins) {
    const spec = typeof entry === 'string' ? { source: entry, activate: true } : entry;
    const { source, version, activate: shouldActivate = true } = spec;
    onStep?.(`installing plugin ${source}…`);
    const args = ['plugin', 'install', source];
    // wordpress.org slugs are already idempotent on reinstall; zip URLs
    // error on a repeat install unless forced.
    if (/^https?:\/\//.test(source)) args.push('--force');
    if (version) args.push(`--version=${version}`);
    if (shouldActivate) args.push('--activate');
    const result = await runWp(args, { path });
    if (result.code !== 0) fail(`wp plugin install ${source}`, result);
  }
  for (const slug of activate) {
    onStep?.(`activating ${slug}…`);
    const result = await runWp(['plugin', 'activate', slug], { path });
    if (result.code !== 0) fail(`wp plugin activate ${slug}`, result);
  }
}

async function isPluginActive(path, slug) {
  const result = await runWp(['plugin', 'is-active', slug], { path });
  return result.code === 0;
}

async function findLatestZip(filePrefix) {
  let entries;
  try {
    entries = await readdir(PREMIUM_PLUGINS_DIR);
  } catch {
    return null;
  }
  const matches = entries.filter((f) => f.toLowerCase().startsWith(filePrefix.toLowerCase()) && f.toLowerCase().endsWith('.zip'));
  if (!matches.length) return null;
  const withMtime = await Promise.all(
    matches.map(async (f) => ({ f, mtimeMs: (await stat(join(PREMIUM_PLUGINS_DIR, f))).mtimeMs })),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return join(PREMIUM_PLUGINS_DIR, withMtime[0].f);
}

/**
 * Best-effort refresh of the local premium-plugins cache from
 * `PREMIUM_PLUGINS_REPO` — one release tag per plugin slug, each holding
 * that plugin's licensed zip as an asset. Never fatal: offline, `gh`
 * missing/unauthenticated, or no matching release just means
 * `installPremiumPlugins` falls back to whatever's already cached locally
 * (or skips, if nothing is).
 */
export async function syncPremiumPluginsFromGitHub({ onStep } = {}) {
  await mkdir(PREMIUM_PLUGINS_DIR, { recursive: true });
  for (const { slug } of PREMIUM_PLUGINS) {
    const result = await spawnCapture('gh', [
      'release',
      'download',
      slug,
      '--repo',
      PREMIUM_PLUGINS_REPO,
      '--dir',
      PREMIUM_PLUGINS_DIR,
      '--clobber',
      '--pattern',
      '*.zip',
    ]);
    if (result.code === 0) {
      onStep?.(`synced ${slug} from ${PREMIUM_PLUGINS_REPO}`);
    } else {
      onStep?.(`  (couldn't sync ${slug} from GitHub, using local cache if present: ${(result.stderr || result.stdout).trim().split('\n')[0]})`);
    }
  }
}

/**
 * Best-effort, never fatal — a missing zip or an activation failure (e.g. a
 * license key that still needs entering by hand in wp-admin) skips that
 * plugin and moves on rather than aborting the whole scaffold. Returns the
 * slugs actually installed, for `sandbox.config.json` bookkeeping.
 */
export async function installPremiumPlugins({ path, onStep }) {
  const installed = [];
  for (const { slug, filePrefix } of PREMIUM_PLUGINS) {
    if (await isPluginActive(path, slug)) {
      installed.push(slug);
      continue;
    }
    const zipPath = await findLatestZip(filePrefix);
    if (!zipPath) {
      onStep?.(`skipping ${slug} — no zip in ${PREMIUM_PLUGINS_DIR} (drop your licensed zip there to enable)`);
      continue;
    }
    onStep?.(`installing ${slug} from ${zipPath}…`);
    const result = await runWp(['plugin', 'install', zipPath, '--force', '--activate'], { path });
    if (result.code !== 0) {
      onStep?.(`  (skipped ${slug}: ${(result.stderr || result.stdout).trim()})`);
      continue;
    }
    installed.push(slug);
  }
  return installed;
}

/**
 * The MCP gateway (agent-connector-for-wp) + its abilities companion
 * (universal-abilities-plugin), both from GitHub release zips (not
 * wordpress.org). Guarded by `wp plugin is-active` so a git checkout a
 * setup script (Phase 8) already placed and activated is never clobbered by
 * the release zip — this matters more here than in the original, since the
 * sibling-checkout workflow uses directory junctions and is the norm rather
 * than an edge case on a native install.
 */
export async function installAgentConnector({ path, onStep }) {
  if (!(await isPluginActive(path, 'agent-connector-for-wp'))) {
    onStep?.('installing Agent Connector…');
    const result = await runWp(['plugin', 'install', AGENT_CONNECTOR_URL, '--force', '--activate'], { path });
    if (result.code !== 0) fail('install agent-connector-for-wp', result);
  }
  if (!(await isPluginActive(path, 'universal-abilities-plugin'))) {
    onStep?.('installing the abilities companion…');
    const result = await runWp(['plugin', 'install', UNIVERSAL_ABILITIES_URL, '--force', '--activate'], { path });
    if (result.code !== 0) fail('install universal-abilities-plugin', result);
  }

  onStep?.('enabling MCP abilities…');
  for (const [option, value] of [
    ['agent_connector_for_wp_enabled', '1'],
    ['agent_connector_for_wp_builtin_abilities', '1'],
    ['agent_connector_for_wp_mcp_debug', '1'],
  ]) {
    const result = await runWp(['option', 'update', option, value], { path });
    if (result.code !== 0) fail(`wp option update ${option}`, result);
  }
}
