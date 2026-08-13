// Full teardown for a scaffolded site. Docker gave this away free via
// `compose down -v`; on Laragon it has to be built by hand — and with sites
// accumulating over time (87+ on this machine before this project even
// started), orphaned DBs, vhosts, and MCP entries are the real long-term
// cost of not having it.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findVhostForProject } from './laragon.mjs';
import { removeHostsEntries } from './wildcard.mjs';
import { removeDirSafely } from './junctions.mjs';
import { dropDatabase, parseDbHost, resolveRootCredential } from './mysql.mjs';
import { revokeAppPasswords } from './mcp.mjs';
import { psRun } from './win.mjs';
import { WWW_DIR } from './paths.mjs';

/**
 * Split on either line ending — see engine.js's copy. A CRLF-normalised .env
 * made every line fail this match, and an EMPTY env here silently downgraded
 * destroy to "no database recorded in .env": the DB and its user survived a
 * teardown that reported success.
 */
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** True when `url`'s hostname is this site's — the guard that keeps destroy from clobbering another site's live wiring. */
function urlBelongsToSite(url, siteHostname) {
  if (!url || !siteHostname) return false;
  try {
    return new URL(url).hostname.toLowerCase() === siteHostname.toLowerCase();
  } catch {
    return false;
  }
}

/** stderr patterns that mean the agent CLI itself never ran — the remove can't have happened, so don't report it as removed. */
function commandNeverRan(result) {
  return result.code === null || /is not recognized|CommandNotFoundException|ENOENT/i.test(result.stderr || '');
}

/**
 * MCP entries are MACHINE-GLOBAL (one 'wordpress' entry, --scope user), and
 * scaffolding site B overwrites site A's entry — so destroying old site A
 * must NOT blindly remove what is now site B's live wiring. Each removal is
 * gated on the current entry actually pointing at the site being destroyed;
 * when it points elsewhere the entry (and the site-agnostic playwright one
 * serving it) is left alone, with a message saying so.
 *
 * `code === null` from psRun means the spawn itself never ran (the .cmd/.ps1
 * shim problem psRun exists for); 'is not recognized' means the agent CLI
 * was uninstalled since scaffold — both are reported instead of being
 * counted as a successful removal.
 */
async function removeMcpEntries(agents, siteHostname, onStep, projectDir) {
  const removed = [];
  if (agents.includes('claude')) {
    // 1.10.0+: claude's wiring is the site's own .mcp.json, which leaves with
    // the folder — nothing global to clean. The user-scope path below stays
    // for sites wired before 1.10.0, whose entry really is machine-global.
    const hasProjectWiring = projectDir
      ? await readFile(join(projectDir, '.mcp.json'), 'utf8').then(
          (raw) => Boolean(JSON.parse(raw)?.mcpServers?.wordpress),
          () => false,
        )
      : false;
    let currentUrl = null;
    try {
      const cfg = JSON.parse(await readFile(join(homedir(), '.claude.json'), 'utf8'));
      currentUrl = cfg.mcpServers?.wordpress?.env?.WP_API_URL || null;
    } catch {
      // unreadable config — fall through to the conservative path below
    }
    if (hasProjectWiring && !urlBelongsToSite(currentUrl, siteHostname)) {
      onStep?.("  (claude's wiring is this site's own .mcp.json — it leaves with the folder)");
      removed.push('claude');
    } else if (!urlBelongsToSite(currentUrl, siteHostname)) {
      onStep?.(
        currentUrl
          ? `  (claude's wordpress MCP entry points at ${currentUrl} — another site's wiring, leaving it)`
          : "  (no claude wordpress MCP entry found for this site — nothing to remove)",
      );
    } else {
      const r1 = await psRun('claude', ['mcp', 'remove', 'wordpress', '--scope', 'user']);
      if (commandNeverRan(r1)) {
        onStep?.(`  (claude CLI not runnable — MCP entries left in place: ${(r1.stderr || '').trim().split('\n')[0]})`);
      } else {
        const r2 = await psRun('claude', ['mcp', 'remove', 'playwright', '--scope', 'user']);
        if (commandNeverRan(r2)) {
          onStep?.('  (removed the wordpress MCP entry, but the playwright removal failed — remove it by hand with: claude mcp remove playwright --scope user)');
        }
        removed.push('claude');
      }
    }
  }
  if (agents.includes('codex')) {
    const probe = await psRun('codex', ['mcp', 'get', 'wordpress']);
    const belongsHere = probe.code === 0 && siteHostname && probe.stdout.toLowerCase().includes(siteHostname.toLowerCase());
    if (commandNeverRan(probe)) {
      onStep?.('  (codex CLI not runnable — MCP entries left in place)');
    } else if (!belongsHere) {
      onStep?.("  (codex's wordpress MCP entry doesn't point at this site — leaving it)");
    } else {
      const r1 = await psRun('codex', ['mcp', 'remove', 'wordpress']);
      const r2 = await psRun('codex', ['mcp', 'remove', 'playwright']);
      if (commandNeverRan(r1) || commandNeverRan(r2)) {
        onStep?.(`  (couldn't run codex mcp remove: ${(r1.stderr || r2.stderr || '').trim().split('\n')[0]})`);
      } else {
        removed.push('codex');
      }
    }
  }
  if (agents.includes('cursor')) {
    const p = join(homedir(), '.cursor', 'mcp.json');
    try {
      const cfg = JSON.parse(await readFile(p, 'utf8'));
      const currentUrl = cfg.mcpServers?.wordpress?.env?.WP_API_URL || null;
      if (!urlBelongsToSite(currentUrl, siteHostname)) {
        onStep?.("  (cursor's wordpress MCP entry doesn't point at this site — leaving it)");
      } else {
        delete cfg.mcpServers.wordpress;
        delete cfg.mcpServers.playwright;
        await writeFile(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
        removed.push('cursor');
      }
    } catch {
      // no config to clean up
    }
  }
  if (agents.includes('opencode')) {
    const p = join(homedir(), '.config', 'opencode', 'opencode.json');
    try {
      const cfg = JSON.parse(await readFile(p, 'utf8'));
      const currentUrl = cfg.mcp?.wordpress?.environment?.WP_API_URL || null;
      if (!urlBelongsToSite(currentUrl, siteHostname)) {
        onStep?.("  (opencode's wordpress MCP entry doesn't point at this site — leaving it)");
      } else {
        delete cfg.mcp.wordpress;
        delete cfg.mcp.playwright;
        await writeFile(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
        removed.push('opencode');
      }
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
  const removedAgents = await removeMcpEntries(cfg.agents || [], env.SITE_HOST || null, onStep, projectDir);

  let appPasswordRevoked = null;
  if (env.WP_ADMIN_USER) {
    onStep?.('revoking the WordPress application password…');
    // Was `delete <user> agentpress` — a NAME where wp-cli wants a UUID, so it
    // matched nothing and silently revoked nothing, while destroy's own
    // preamble told the user the credential had been removed. That left a live
    // admin-equivalent password (which reaches the abilities pack) on a site
    // being torn down. revokeAppPasswords resolves the UUIDs first.
    appPasswordRevoked = await revokeAppPasswords({ path: publicDir, adminUser: env.WP_ADMIN_USER }).catch(() => null);
    if (appPasswordRevoked === null) {
      onStep?.('  (could not confirm the application password was revoked — revoke it by hand in wp-admin ▸ Users ▸ Profile before the site goes away)');
    }
  }

  let dbDropped = false;
  let dbSkipReason = env.DB_NAME && env.DB_USER ? null : 'no database recorded in .env';
  if (env.DB_NAME && env.DB_USER) {
    onStep?.('dropping the database…');
    // Target the server the site was PROVISIONED on (.env's DB_HOST carries
    // host:port) — resolving against the current process's default port
    // could silently miss the right server, or drop against a different one.
    const target = parseDbHost(env.DB_HOST);
    const cred = await resolveRootCredential(target);
    if (!cred) {
      dbSkipReason = `could not resolve MySQL root credentials for ${target.host}:${target.port} — the database ${env.DB_NAME} was NOT dropped (is MySQL running? set AGENTPRESS_MYSQL_ROOT_PASSWORD if root has a custom password)`;
      onStep?.(`  (${dbSkipReason})`);
    } else {
      const result = await dropDatabase(env.DB_NAME, env.DB_USER, cred, target);
      if (result.code !== 0) {
        dbSkipReason = `drop database failed: ${(result.stderr || result.stdout).trim()}`;
        onStep?.(`  (${dbSkipReason})`);
      } else {
        dbDropped = true;
      }
    }
  }

  // STOP HERE when the database step failed. `.env` is the only record of DB_NAME
  // and DB_USER anywhere, so removing the project directory next would strand the
  // database and its user with nothing left on disk naming them — and the old order
  // did exactly that, under a green "✓ Destroyed."
  //
  // Retrying after the user starts MySQL is provably safe: revokeAppPasswords
  // returns 0 when none of ours remain, removeMcpEntries reports "nothing to
  // remove", and both vhost removal and the directory delete are still ahead. So
  // leaving the site in place is strictly better than a half teardown.
  if (dbSkipReason && dbSkipReason !== 'no database recorded in .env') {
    return {
      removedAgents,
      dbDropped: false,
      dbSkipReason,
      appPasswordRevoked,
      hostname: env.SITE_HOST || null,
      halted: true,
      recovery: { dbName: env.DB_NAME, dbUser: env.DB_USER, dbHost: env.DB_HOST || null },
    };
  }

  onStep?.('removing the vhost…');
  const vhost = await findVhostForProject(projectDir);
  if (vhost) await rm(vhost.file, { force: true });

  // Hosts BEFORE the folder delete, deliberately. Laragon rewrites the entire
  // hosts file from a temp copy when it syncs, and deleting a www folder is a
  // trigger — the first version of this feature ran after the delete and left
  // the machine's hosts file EMPTY (see hostsRemovalScript in wildcard.mjs for
  // the full account and the guards). Running here keeps our elevated write
  // out of that window. Never fatal: ok:false just means the summary prints
  // the leftover line, exactly as before the feature existed.
  //
  // includeLaragon takes the site's own "#laragon magic!" line too — the
  // operator's field test showed Laragon prunes those only when a NEW folder
  // appears in www, so after destroying your last site the dead line lingers
  // through any number of service restarts. Removing it here is safe from
  // Laragon's side: its sync is a full regenerate, and a hostname without a
  // folder is exactly what it would drop itself.
  let hostsEntry = { ok: true, removed: 0, remaining: [], reason: null };
  if (env.SITE_HOST) {
    onStep?.('removing the hosts entry (a Windows permission prompt may appear — approve it)…');
    hostsEntry = await removeHostsEntries([env.SITE_HOST], { includeLaragon: true }).catch((err) => ({
      ok: false,
      removed: 0,
      remaining: [env.SITE_HOST],
      reason: err.message,
    }));
    if (!hostsEntry.ok) onStep?.(`  (hosts entry not removed: ${hostsEntry.reason})`);
  }

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

  return { removedAgents, dbDropped, dbSkipReason, appPasswordRevoked, hostsEntry, hostname: env.SITE_HOST || vhost?.hostname || null, halted: false };
}
