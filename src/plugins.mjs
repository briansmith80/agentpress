// Plugin install/activate + the Agent Connector companion plugins. Ported
// policy from the Docker original — this layer never touched Docker
// directly (it always went through `wp` in the workspace container), so it
// carries over unchanged except for dropping the exec prefix.
import { runWp } from './wp.mjs';

const AGENT_CONNECTOR_URL = 'https://github.com/soflyy/agent-connector-for-wp/releases/latest/download/agent-connector-for-wp.zip';
const UNIVERSAL_ABILITIES_URL =
  'https://github.com/soflyy/agent-connector-for-wp/releases/download/universal-abilities-plugin/universal-abilities-plugin.zip';

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
