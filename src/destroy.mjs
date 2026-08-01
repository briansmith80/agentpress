// Full teardown for a scaffolded site. Docker gave this away free via
// `compose down -v`; on Laragon it has to be built by hand — and with sites
// accumulating over time (87+ on this machine before this project even
// started), orphaned DBs, vhosts, and MCP entries are the real long-term
// cost of not having it.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findVhostForProject } from './laragon.mjs';
import { removeDirSafely } from './junctions.mjs';
import { dropDatabase, resolveRootCredential } from './mysql.mjs';
import { runWp } from './wp.mjs';
import { psRun } from './win.mjs';
import { WWW_DIR } from './paths.mjs';

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * `code === null` means the spawn itself never ran (e.g. `claude`/`codex`
 * are npm-global `.cmd`/`.ps1` shims — the exact bug `psRun` fixes; a raw
 * `spawn(shell:false)` here previously failed with ENOENT and was never
 * checked, so `destroy` silently left MCP entries orphaned while reporting
 * them removed). Any other exit code means the command actually ran —
 * `claude mcp remove` exiting non-zero for "nothing to remove" still leaves
 * the entry gone, which is what matters here.
 */
async function removeMcpEntries(agents, onStep) {
  const removed = [];
  if (agents.includes('claude')) {
    const r1 = await psRun('claude', ['mcp', 'remove', 'wordpress', '--scope', 'user']);
    const r2 = await psRun('claude', ['mcp', 'remove', 'playwright', '--scope', 'user']);
    if (r1.code === null || r2.code === null) {
      onStep?.(`  (couldn't run claude mcp remove: ${(r1.stderr || r2.stderr || '').trim()})`);
    } else {
      removed.push('claude');
    }
  }
  if (agents.includes('codex')) {
    const r1 = await psRun('codex', ['mcp', 'remove', 'wordpress']);
    const r2 = await psRun('codex', ['mcp', 'remove', 'playwright']);
    if (r1.code === null || r2.code === null) {
      onStep?.(`  (couldn't run codex mcp remove: ${(r1.stderr || r2.stderr || '').trim()})`);
    } else {
      removed.push('codex');
    }
  }
  if (agents.includes('cursor')) {
    const p = join(homedir(), '.cursor', 'mcp.json');
    try {
      const cfg = JSON.parse(await readFile(p, 'utf8'));
      if (cfg.mcpServers) {
        delete cfg.mcpServers.wordpress;
        delete cfg.mcpServers.playwright;
        await writeFile(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      }
      removed.push('cursor');
    } catch {
      // no config to clean up
    }
  }
  if (agents.includes('opencode')) {
    const p = join(homedir(), '.config', 'opencode', 'opencode.json');
    try {
      const cfg = JSON.parse(await readFile(p, 'utf8'));
      if (cfg.mcp) {
        delete cfg.mcp.wordpress;
        delete cfg.mcp.playwright;
        await writeFile(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      }
      removed.push('opencode');
    } catch {
      // no config to clean up
    }
  }
  return removed;
}

/**
 * Order matters: the app password and MCP entries must go while WP-CLI and
 * the DB are still reachable — reversing this (DB first) would leave orphan
 * app-password/MCP state with no site left to clean it from. The project
 * directory is removed last, via removeDirSafely so a junctioned sibling
 * checkout (Phase 6) is unlinked before the recursive delete rather than
 * followed through.
 */
export async function destroySite({ projectDir, onStep }) {
  const env = parseEnvFile(await readFile(join(projectDir, '.env'), 'utf8'));
  let cfg = { agents: [] };
  try {
    cfg = JSON.parse(await readFile(join(projectDir, 'sandbox.config.json'), 'utf8'));
  } catch {
    // optional file
  }
  const publicDir = join(projectDir, 'public');

  onStep?.('removing MCP registrations…');
  const removedAgents = await removeMcpEntries(cfg.agents || [], onStep);

  if (env.WP_ADMIN_USER) {
    onStep?.('deleting the WordPress application password…');
    await runWp(['user', 'application-password', 'delete', env.WP_ADMIN_USER, 'katalyst-laragon'], { path: publicDir }).catch(() => {});
  }

  let dbDropped = false;
  if (env.DB_NAME && env.DB_USER) {
    onStep?.('dropping the database…');
    const cred = await resolveRootCredential();
    if (cred) {
      const result = await dropDatabase(env.DB_NAME, env.DB_USER, cred);
      if (result.code !== 0) {
        onStep?.(`  (drop database failed: ${(result.stderr || result.stdout).trim()})`);
      } else {
        dbDropped = true;
      }
    }
  }

  onStep?.('removing the vhost…');
  const vhost = await findVhostForProject(projectDir);
  if (vhost) await rm(vhost.file, { force: true });

  onStep?.('removing the project directory…');
  // Windows can't rmdir a directory that's a live process's cwd — a real
  // hit, not just a test artifact: the natural way to run this command is
  // `cd` into the site first, which is exactly that state. Step out before
  // removing; WWW_DIR is always a safe ancestor to land on.
  const normalize = (p) => p.replace(/[/\\]+$/, '').toLowerCase();
  if (normalize(process.cwd()) === normalize(projectDir) || normalize(process.cwd()).startsWith(`${normalize(projectDir)}\\`)) {
    process.chdir(WWW_DIR);
  }
  await removeDirSafely(projectDir);

  return { removedAgents, dbDropped, hostname: env.SITE_HOST || vhost?.hostname || null };
}
