// Plugin install/activate + the Agent Connector companion plugins. Ported
// policy from the Docker original — this layer never touched Docker
// directly (it always went through `wp` in the workspace container), so it
// carries over unchanged except for dropping the exec prefix.
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runWp, spawnCapture } from './wp.mjs';
import { CONFIG_PATH, PREMIUM_PLUGINS_DIR } from './paths.mjs';

// One release tag per plugin (mirrors the `universal-abilities-plugin`
// tag-per-asset pattern used for the connector below) in a private repo of
// licensed zips — `gh` (if installed and authenticated with access)
// refreshes the local cache from here so a zip dropped in on one machine
// doesn't need manually re-copying to every other one. Override for your
// own repo via KATALYST_PREMIUM_PLUGINS_REPO or, persistently, via
// ~/.katalyst-laragon/config.json: {"premiumPluginsRepo": "you/your-repo"}.
const DEFAULT_PREMIUM_PLUGINS_REPO = 'briansmith80/oxygen-premium-plugins';

async function premiumPluginsRepo() {
  if (process.env.KATALYST_PREMIUM_PLUGINS_REPO) return process.env.KATALYST_PREMIUM_PLUGINS_REPO;
  try {
    const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    if (typeof config.premiumPluginsRepo === 'string' && config.premiumPluginsRepo.trim()) {
      return config.premiumPluginsRepo.trim();
    }
  } catch {
    // no config file — use the default
  }
  return DEFAULT_PREMIUM_PLUGINS_REPO;
}

// Pinned to a tested release, not /latest/ — these download at scaffold time
// on every machine, so an upstream release would otherwise change behavior
// on both machines simultaneously with zero local change. Bump deliberately.
const AGENT_CONNECTOR_URL = 'https://github.com/soflyy/agent-connector-for-wp/releases/download/v1.26.0/agent-connector-for-wp.zip';
const UNIVERSAL_ABILITIES_URL =
  'https://github.com/soflyy/agent-connector-for-wp/releases/download/universal-abilities-plugin/universal-abilities-plugin.zip';

/**
 * Oxygen/Breakdance are commercial — not on wordpress.org, no stable public
 * download URL. This looks in `~/.katalyst-laragon/premium-plugins/` for a
 * zip matching each slug (exact `<slug>.zip`, or `<slug>-*.zip` for the
 * version-suffixed names vendors ship) and picks the newest by mtime if more
 * than one is present. Drop a licensed zip in that folder once and every
 * scaffold picks it up; if it's missing, the plugin is skipped with a clear
 * message rather than failing the scaffold.
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

function zipMatchesSlug(fileName, { slug, filePrefix }) {
  const f = fileName.toLowerCase();
  if (!f.endsWith('.zip')) return false;
  return f === `${slug}.zip` || f.startsWith(filePrefix.toLowerCase());
}

async function findLatestZip(plugin) {
  let entries;
  try {
    entries = await readdir(PREMIUM_PLUGINS_DIR);
  } catch {
    return null;
  }
  const matches = entries.filter((f) => zipMatchesSlug(f, plugin));
  if (!matches.length) return null;
  const withMtime = await Promise.all(
    matches.map(async (f) => ({ f, mtimeMs: (await stat(join(PREMIUM_PLUGINS_DIR, f))).mtimeMs })),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return join(PREMIUM_PLUGINS_DIR, withMtime[0].f);
}

/**
 * Best-effort refresh of the local premium-plugins cache from the configured
 * repo — one release tag per plugin slug, each holding that plugin's
 * licensed zip as an asset. Never fatal: no `gh` at all, offline,
 * unauthenticated, or no matching release just means `installPremiumPlugins`
 * falls back to whatever's already cached locally (or skips, if nothing is).
 * Downloads land in a temp subdir and only move into the cache on success,
 * so a connection killed mid-transfer can't leave a truncated zip shadowing
 * a good older one.
 */
export async function syncPremiumPluginsFromGitHub({ onStep } = {}) {
  try {
    await mkdir(PREMIUM_PLUGINS_DIR, { recursive: true });
  } catch (err) {
    onStep?.(`  (couldn't prepare ${PREMIUM_PLUGINS_DIR}: ${err.message} — premium plugin sync skipped)`);
    return;
  }

  const ghProbe = await spawnCapture('gh', ['--version']);
  if (ghProbe.code === null) {
    onStep?.(
      'GitHub CLI (gh) not installed — skipping premium plugin sync (optional). To auto-install ' +
        `your own licensed plugins, drop zips named oxygen-*.zip etc. into ${PREMIUM_PLUGINS_DIR}`,
    );
    return;
  }

  const repo = await premiumPluginsRepo();
  const tmpDir = join(PREMIUM_PLUGINS_DIR, '.sync-tmp');
  for (const { slug } of PREMIUM_PLUGINS) {
    try {
      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { recursive: true });
      const result = await spawnCapture('gh', [
        'release',
        'download',
        slug,
        '--repo',
        repo,
        '--dir',
        tmpDir,
        '--clobber',
        '--pattern',
        '*.zip',
      ]);
      if (result.code === 0) {
        for (const f of await readdir(tmpDir)) {
          await rm(join(PREMIUM_PLUGINS_DIR, f), { force: true });
          await rename(join(tmpDir, f), join(PREMIUM_PLUGINS_DIR, f));
        }
        onStep?.(`synced ${slug} from ${repo}`);
      } else {
        onStep?.(`  (couldn't sync ${slug} from ${repo}, using local cache if present: ${(result.stderr || result.stdout).trim().split('\n')[0]})`);
      }
    } catch (err) {
      onStep?.(`  (couldn't sync ${slug}: ${err.message})`);
    }
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Best-effort, never fatal — a missing zip or an activation failure (e.g. a
 * license key that still needs entering by hand in wp-admin) skips that
 * plugin and moves on rather than aborting the whole scaffold. A zip that
 * installs cleanly but does NOT contain the expected plugin (a colliding
 * `oxygen-*.zip` add-on, say) is reported instead of silently recorded as
 * the real thing. Returns the slugs actually installed and verified active,
 * for `sandbox.config.json` bookkeeping.
 */
export async function installPremiumPlugins({ path, onStep }) {
  const installed = [];
  for (const plugin of PREMIUM_PLUGINS) {
    const { slug, filePrefix } = plugin;
    if (await isPluginActive(path, slug)) {
      installed.push(slug);
      continue;
    }
    const zipPath = await findLatestZip(plugin);
    if (!zipPath) {
      onStep?.(`skipping ${slug} — no ${filePrefix}*.zip (or ${slug}.zip) in ${PREMIUM_PLUGINS_DIR}; drop your licensed zip there to enable`);
      continue;
    }
    onStep?.(`installing ${slug} from ${zipPath}…`);
    const result = await runWp(['plugin', 'install', zipPath, '--force', '--activate'], { path });
    if (result.code !== 0) {
      onStep?.(`  (skipped ${slug}: ${(result.stderr || result.stdout).trim()})`);
      continue;
    }
    if (!(await isPluginActive(path, slug))) {
      onStep?.(`  (installed ${zipPath} but it is not the "${slug}" plugin — wrong zip? Not recording it as ${slug}.)`);
      continue;
    }
    installed.push(slug);
  }
  return installed;
}

/**
 * Applies configured license keys after the premium plugins land. Oxygen 6
 * ships an official WP-CLI command for this (`wp oxygen license <key>`,
 * registered under BREAKDANCE_MODE) that stores the key AND validates it
 * against the vendor; the Elements/Forms extensions carry no licensing of
 * their own — one key covers all three (verified by reading the plugin
 * source). Keys come from ~/.katalyst-laragon/config.json:
 *   { "licenses": { "oxygen": "<32-char key>" } }
 * (env override: KATALYST_OXYGEN_LICENSE). Best-effort, never fatal —
 * validation needs the network, and an invalid/expired key is reported,
 * not thrown. The key transits argv of a local shell:false spawn, same
 * momentary-exposure acceptance as `wp config create --dbpass`.
 */
export async function applyLicenses({ path, slugs = [], onStep }) {
  if (!slugs.includes('oxygen')) return;
  let key = process.env.KATALYST_OXYGEN_LICENSE || null;
  if (!key) {
    try {
      const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
      key = config.licenses?.oxygen || null;
    } catch {
      // no config — nothing to apply
    }
  }
  if (!key) {
    onStep?.(`(no Oxygen license key configured — add {"licenses":{"oxygen":"<key>"}} to ${CONFIG_PATH} to auto-activate, or enter it once in wp-admin)`);
    return;
  }
  onStep?.('activating the Oxygen license…');
  const result = await runWp(['oxygen', 'license', key], { path });
  const output = `${result.stdout}${result.stderr}`;
  const status = output.match(/Status:\s*(.+)/)?.[1]?.trim();
  const activation = output.match(/Activation:\s*(.+)/)?.[1]?.trim();
  if (result.code === 0 && /Success: License key set/i.test(output)) {
    onStep?.(`Oxygen license active${status ? ` (${status}${activation ? `, ${activation}` : ''})` : ''}`);
  } else {
    onStep?.(
      `(Oxygen license key was submitted but did not validate${status ? ` — status: ${status}` : ''}; ` +
        'check the key in wp-admin ▸ Oxygen ▸ License, or fix it in ' +
        `${CONFIG_PATH})`,
    );
  }
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
