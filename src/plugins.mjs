// Plugin install/activate + the Agent Connector companion plugins. Ported
// policy from the Docker original — this layer never touched Docker
// directly (it always went through `wp` in the workspace container), so it
// carries over unchanged except for dropping the exec prefix.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { resolvePhpExe, runWp, spawnCapture } from './wp.mjs';
import { resolveOnPath } from './win.mjs';
import { CONFIG_PATH, PREMIUM_PLUGINS_DIR } from './paths.mjs';
import { loadConfig } from './config.mjs';

// One release tag per plugin (mirrors the `universal-abilities-plugin`
// tag-per-asset pattern used for the connector below) in a private repo of
// licensed zips — `gh` (if installed and authenticated with access)
// refreshes the local cache from here so a zip dropped in on one machine
// doesn't need manually re-copying to every other one. Override for your
// own repo via AGENTPRESS_PREMIUM_PLUGINS_REPO or, persistently, via
// ~/.agentpress/config.json: {"premiumPluginsRepo": "you/your-repo"}.
// NO default repo: a published package must never sync third-party zips from
// its author's account onto other people's machines. Sync only ever targets a
// repo the operator named themselves (env var or config.json); otherwise the
// local drop folder is the only source.
const DEFAULT_PREMIUM_PLUGINS_REPO = null;

async function premiumPluginsRepo() {
  const envRepo = process.env.AGENTPRESS_PREMIUM_PLUGINS_REPO ?? process.env.KATALYST_PREMIUM_PLUGINS_REPO;
  if (envRepo) return envRepo;
  const config = await loadConfig();
  if (typeof config.premiumPluginsRepo === 'string' && config.premiumPluginsRepo.trim()) {
    return config.premiumPluginsRepo.trim();
  }
  return DEFAULT_PREMIUM_PLUGINS_REPO;
}

/** Only accept release assets whose filename matches the slug being synced — a release must not be able to drop arbitrary zips into the cache and shadow a good one by mtime. */
function assetBelongsToSlug(fileName, plugin) {
  return zipMatchesSlug(fileName, plugin);
}

/**
 * Availability report for the setup assistant and the scaffold-time picker:
 * which premium plugins have a usable zip in the local cache right now.
 * Selection is PER-PROJECT (chosen at scaffold time — a shop needs Woo, a
 * brochure site doesn't); setup's job is only making plugins AVAILABLE.
 */
export async function premiumPluginAvailability() {
  const out = [];
  for (const plugin of PREMIUM_PLUGINS) {
    const zip = await findLatestZip(plugin);
    out.push({ ...plugin, available: Boolean(zip), zip });
  }
  return out;
}

/** Resolves a scaffold's premium selection to plugin entries; `selection` is a list of slugs (unknown slugs dropped). */
function resolveSelection(selection) {
  if (!Array.isArray(selection)) return PREMIUM_PLUGINS;
  return PREMIUM_PLUGINS.filter((p) => selection.includes(p.slug));
}

// Pinned to a tested release, not /latest/ — these download at scaffold time
// on every machine, so an upstream release would otherwise change behavior
// on both machines simultaneously with zero local change. Bump deliberately.
const AGENT_CONNECTOR_URL = 'https://github.com/soflyy/agent-connector-for-wp/releases/download/v1.26.0/agent-connector-for-wp.zip';
const UNIVERSAL_ABILITIES_URL =
  'https://github.com/soflyy/agent-connector-for-wp/releases/download/universal-abilities-plugin/universal-abilities-plugin.zip';

/**
 * Oxygen/Breakdance are commercial — not on wordpress.org, no stable public
 * download URL. This looks in `~/.agentpress/premium-plugins/` for a
 * zip matching each slug (exact `<slug>.zip`, or `<slug>-*.zip` for the
 * version-suffixed names vendors ship) and picks the newest by mtime if more
 * than one is present. Drop a licensed zip in that folder once and every
 * scaffold picks it up; if it's missing, the plugin is skipped with a clear
 * message rather than failing the scaffold.
 */
export const PREMIUM_PLUGINS = [
  { slug: 'oxygen', filePrefix: 'oxygen-', label: 'Oxygen Builder' },
  { slug: 'breakdance-elements-for-oxygen', filePrefix: 'breakdance-elements-for-oxygen-', label: 'Breakdance Elements for Oxygen' },
  { slug: 'breakdance-forms-for-oxygen', filePrefix: 'breakdance-forms-for-oxygen-', label: 'Breakdance Forms for Oxygen' },
  // The Woo integration only hard-requires Oxygen, but it's pointless
  // without WooCommerce itself — `requires` installs wordpress.org deps
  // first (idempotent) when this plugin is selected.
  { slug: 'breakdance-woocommerce-for-oxygen', filePrefix: 'breakdance-woocommerce-for-oxygen-', label: 'Breakdance WooCommerce for Oxygen (installs WooCommerce too)', requires: ['woocommerce'] },
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

export function zipMatchesSlug(fileName, { slug, filePrefix }) {
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
export async function syncPremiumPluginsFromGitHub({ selection, onStep } = {}) {
  try {
    await mkdir(PREMIUM_PLUGINS_DIR, { recursive: true });
  } catch (err) {
    onStep?.(`  (couldn't prepare ${PREMIUM_PLUGINS_DIR}: ${err.message} — premium plugin sync skipped)`);
    return;
  }

  const selected = resolveSelection(selection);
  if (!selected.length) return; // this project opted out of premium plugins

  const repo = await premiumPluginsRepo();
  if (!repo) {
    onStep?.(
      `no premium-plugins repo configured — using only the zips already in ${PREMIUM_PLUGINS_DIR}\n` +
        '    (set premiumPluginsRepo in ~/.agentpress/config.json to sync from your own private repo)',
    );
    return;
  }
  // A repo string reaches `gh --repo`: allow only owner/name so it can neither
  // become another flag nor redirect gh at a different host.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    onStep?.(`  (ignoring premiumPluginsRepo "${repo}" — expected the form owner/repo)`);
    return;
  }

  // Absolute path only: Windows CreateProcess searches the CURRENT DIRECTORY
  // before PATH, so a gh.exe dropped in a project folder would run instead.
  const ghExe = await resolveOnPath('gh');
  const ghProbe = ghExe ? await spawnCapture(ghExe, ['--version']) : { code: null };
  if (ghProbe.code === null) {
    onStep?.(
      'GitHub CLI (gh) not installed — skipping premium plugin sync (optional). To auto-install ' +
        `your own licensed plugins, drop zips named oxygen-*.zip etc. into ${PREMIUM_PLUGINS_DIR}`,
    );
    return;
  }

  const tmpDir = join(PREMIUM_PLUGINS_DIR, '.sync-tmp');
  for (const { slug } of selected) {
    try {
      await rm(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { recursive: true });
      const result = await spawnCapture(ghExe, [
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
        const plugin = selected.find((p2) => p2.slug === slug);
        for (const f of await readdir(tmpDir)) {
          // basename() so a crafted asset name can never traverse out of the cache
          const safe = basename(f);
          if (!plugin || !assetBelongsToSlug(safe, plugin)) {
            onStep?.(`  (ignoring unexpected asset "${safe}" in the ${slug} release)`);
            continue;
          }
          await rm(join(PREMIUM_PLUGINS_DIR, safe), { force: true });
          await rename(join(tmpDir, f), join(PREMIUM_PLUGINS_DIR, safe));
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
export async function installPremiumPlugins({ path, selection, onStep }) {
  const installed = [];
  const selected = resolveSelection(selection);
  for (const plugin of selected) {
    const { slug, filePrefix, requires = [] } = plugin;
    if (await isPluginActive(path, slug)) {
      installed.push(slug);
      continue;
    }
    const zipPath = await findLatestZip(plugin);
    if (!zipPath) {
      onStep?.(`skipping ${slug} — no ${filePrefix}*.zip (or ${slug}.zip) in ${PREMIUM_PLUGINS_DIR}; drop your licensed zip there to enable`);
      continue;
    }
    for (const dep of requires) {
      if (await isPluginActive(path, dep)) continue;
      onStep?.(`installing ${dep} (required by ${slug})…`);
      const depResult = await runWp(['plugin', 'install', dep, '--activate'], { path });
      if (depResult.code !== 0) {
        onStep?.(`  (couldn't install ${dep}: ${(depResult.stderr || depResult.stdout).trim().split('\n')[0]} — installing ${slug} anyway)`);
      }
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
 * source). Keys come from ~/.agentpress/config.json:
 *   { "licenses": { "oxygen": "<32-char key>" } }
 * (env override: AGENTPRESS_OXYGEN_LICENSE). Best-effort, never fatal —
 * validation needs the network, and an invalid/expired key is reported,
 * not thrown. The key transits argv of a local shell:false spawn, same
 * momentary-exposure acceptance as `wp config create --dbpass`.
 */
export async function applyLicenses({ path, slugs = [], onStep }) {
  if (!slugs.includes('oxygen')) return;
  let key = process.env.AGENTPRESS_OXYGEN_LICENSE ?? process.env.KATALYST_OXYGEN_LICENSE ?? null;
  if (!key) {
    const config = await loadConfig();
    key = config.licenses?.oxygen || null;
  }
  if (!key) {
    // Leads with `setup`, which prompts for the key and stores it, rather than
    // with hand-editing JSON. Sending a user to paste a licence key into a config
    // file by hand is both the least reliable route and the one most likely to end
    // up in the wrong file; the prompt exists precisely so they never have to.
    // No CLI constant in this module (it lives in engine.js), and hardcoding an
    // invocation is exactly the mistake this release is fixing elsewhere — so
    // name the command, not the way to launch it.
    onStep?.(
      '(no Oxygen license key configured — the `setup` command prompts for it and stores it,' +
        ` or set AGENTPRESS_OXYGEN_LICENSE, or add {"licenses":{"oxygen":"<key>"}} to ${CONFIG_PATH}.` +
        ' Without it Oxygen installs unlicensed, and can be activated later in wp-admin.)',
    );
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
 * Brings every installed plugin up to date at the end of the scaffold —
 * wordpress.org plugins update from the directory, and the Oxygen family
 * updates from the vendor because this runs AFTER applyLicenses (the
 * Breakdance extension system authorizes update checks against the active
 * license; the WooCommerce-for-Oxygen shim zip in particular ships old and
 * relies on exactly this to reach the current build). Best-effort: a dead
 * network or a vendor hiccup reports and moves on.
 */
export async function updateAllPlugins({ path, onStep }) {
  onStep?.('updating all plugins to their latest versions…');
  const result = await runWp(['plugin', 'update', '--all'], { path });
  if (result.code !== 0) {
    onStep?.(`  (plugin updates failed — not fatal: ${(result.stderr || result.stdout).trim().split('\n')[0]})`);
    return;
  }
  const updated = (result.stdout.match(/^\| \S+ \| [\d.]/gm) || []).length;
  const summary = result.stdout.match(/(Updated \d+ of \d+ plugins|Plugin already updated|No plugin updates (available|found))/i)?.[0];
  onStep?.(summary ? summary : updated ? `updated ${updated} plugin(s)` : 'plugins are up to date');
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
    // '0', not '1': debug logging persists raw JSON-RPC request/response
    // bodies into the site database indefinitely. Opt in per site in wp-admin
    // when you actually need to debug MCP.
    ['agent_connector_for_wp_mcp_debug', '0'],
  ]) {
    const result = await runWp(['option', 'update', option, value], { path });
    if (result.code !== 0) fail(`wp option update ${option}`, result);
  }
}

// --- vendor patch: Oxygen html-to-page on libxml >= 2.10 ---------------------
//
// THE ONE PLACE THIS TOOL EDITS SOMEONE ELSE'S CODE. Held to a higher bar than
// our own files, because the user did not write it and cannot be expected to
// expect it: every branch below either patches an exactly-known string or
// refuses and says why. It never fuzzy-matches and never fails a scaffold.
//
// The bug: Oxygen's `parse_fragment()` wraps input as
//   '<meta charset="utf-8"><div id="__bdmcp_root__">' . $html . '</div>'
// and calls loadHTML with LIBXML_HTML_NODEFDTD | LIBXML_HTML_NOIMPLIED. A
// leading <meta charset> combined with NOIMPLIED trips a spurious "Memory
// allocation failed" in libxml >= 2.10, so the root node is never built and
// EVERY input fails — including bare text with no tags. html-to-page is the
// documented preferred way to build Oxygen pages, so unpatched it is 100%
// broken on any modern PHP.
//
// Measured here (PHP 8.4.14 / libxml 2.11.9), three wrappers x five inputs:
//   <meta charset>          -> fails on all five
//   <?xml encoding="utf-8"?> -> works on all five, UTF-8 preserved
//   no prefix at all        -> parses, but silently mangles UTF-8 (cafe -> cafÃ©)
// The third is why this is not just "delete the meta tag": that swaps a loud
// failure for quiet corruption. The <meta charset> carried the encoding; the
// XML declaration is what still does while keeping NOIMPLIED semantics.
const OXYGEN_HTML_TO_PAGE_REL = join('wp-content', 'plugins', 'oxygen', 'plugin', 'mcp', 'design', 'html-to-page.php');
const BROKEN_WRAPPER = `'<meta charset="utf-8"><div id="__bdmcp_root__">'`;
const FIXED_WRAPPER = `'<?xml encoding="utf-8"?><div id="__bdmcp_root__">'`;
const PATCH_NOTE = [
  '// PATCHED BY AGENTPRESS: a leading <meta charset> combined with',
  '// LIBXML_HTML_NOIMPLIED trips a spurious "Memory allocation failed" in',
  '// libxml >= 2.10, so loadHTML never builds the __bdmcp_root__ node and every',
  '// parse "fails". An XML encoding declaration sets UTF-8 instead: it keeps',
  '// NOIMPLIED semantics and works across libxml versions. Original saved',
  '// alongside as html-to-page.php.agentpress-bak.',
].join('\n');

/** 21109 -> "2.11.9". LIBXML_VERSION packs major*10000 + minor*100 + patch. */
function formatLibxml(v) {
  return `${Math.floor(v / 10000)}.${Math.floor((v % 10000) / 100)}.${v % 100}`;
}

/** LIBXML_VERSION as an int (21100 = 2.11.0), or null if PHP can't be asked. */
async function libxmlVersion() {
  try {
    const php = await resolvePhpExe();
    const { code, stdout } = await spawnCapture(php, ['-r', 'echo LIBXML_VERSION;']);
    if (code !== 0) return null;
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * MUST run AFTER updateAllPlugins(): that step re-fetches the vendor build from
 * Oxygen's licensed update channel, which would silently undo an earlier patch.
 * Best-effort throughout — a scaffold is not worth failing over a builder tool,
 * and every skip path reports itself rather than passing quietly.
 */
export async function patchOxygenHtmlToPage({ path, onStep }) {
  const file = join(path, OXYGEN_HTML_TO_PAGE_REL);

  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    return { status: 'absent' }; // no Oxygen on this site — nothing to say
  }

  if (source.includes(FIXED_WRAPPER)) return { status: 'already-patched' };

  // Not the string we know: the vendor changed this file. Refuse and SAY SO —
  // guessing at a rewrite of someone else's code is how you corrupt an install.
  if (!source.includes(BROKEN_WRAPPER)) {
    onStep?.('(Oxygen html-to-page looks different from the build we know — leaving it alone; see PLANNING/TODO.md)');
    return { status: 'unrecognised' };
  }

  // Below 2.10 the vendor code is correct, so there is nothing to fix.
  const libxml = await libxmlVersion();
  if (libxml !== null && libxml < 21000) {
    return { status: 'not-affected', libxml };
  }
  // Unknown is NOT the same as not-affected, and lumping them together made this
  // the one silent branch in a patcher whose own guard list (PLANNING/TODO.md)
  // requires every skip to be reported. A PHP startup warning polluting stdout is
  // enough to make the version unreadable, and the user then gets an Oxygen whose
  // html-to-page fails on every input with nothing on screen explaining why.
  if (libxml === null) {
    onStep?.('(could not read the libxml version, so the Oxygen html-to-page patch was SKIPPED — if that tool fails on every input, this is why)');
    return { status: 'unknown-libxml', libxml: null };
  }

  try {
    await writeFile(`${file}.agentpress-bak`, source, 'utf8');
    const patched = source.replace(BROKEN_WRAPPER, `${FIXED_WRAPPER}`).replace(
      /^(\s*)\$wrapped = /m,
      (m, indent) => `${PATCH_NOTE.split('\n').map((l) => indent + l).join('\n')}\n${indent}$wrapped = `,
    );
    await writeFile(file, patched, 'utf8');
    onStep?.(`patched Oxygen html-to-page for libxml ${formatLibxml(libxml)} (upstream bug — it fails on all input unpatched)`);
    return { status: 'patched', libxml };
  } catch (err) {
    onStep?.(`(could not patch Oxygen html-to-page — not fatal: ${err.message})`);
    return { status: 'failed', error: err.message };
  }
}
