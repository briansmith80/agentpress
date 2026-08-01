import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor } from './doctor.mjs';
import { KATALYST_HOME, LARAGON_ROOT, SCAFFOLD_LOCK_PATH, WWW_DIR } from './paths.mjs';
import { findCollisions, validateSiteName } from './names.mjs';
import {
  findVhostForProject,
  hostsHasEntry,
  inferHostnameSuffix,
  mysqlUp,
  pollForVhost,
  preflight,
  repairVhost,
  snapshotHosts,
  testApacheConfig,
  triggerReload,
  verifyDocroot,
} from './laragon.mjs';
import { renameWithRetry, rmWithRetry } from './fsutil.mjs';
import { sleep } from './win.mjs';
import { MYSQL_PORT, provisionDatabase, resolveRootCredential, sanitizeDbIdentifier } from './mysql.mjs';
import { installWordPress } from './wordpress.mjs';
import { generatePassword } from './secrets.mjs';
import { copyTemplates, mergePackageJson } from './templates.mjs';
import { formatEnvironmentsTable, forgetEnvironment, listEnvironments, recordEnvironment } from './registry.mjs';
import { installAgentConnector, installPlugins, installPremiumPlugins, syncPremiumPluginsFromGitHub } from './plugins.mjs';
import { detectAgents } from './agents.mjs';
import { mintAppPassword, MCP_CONFIGURERS } from './mcp.mjs';
import { mintAdminLoginUrl } from './admin-login.mjs';
import { destroySite } from './destroy.mjs';
import { registerQuickApp } from './quickapp.mjs';

const TEMPLATE_DIR = fileURLToPath(new URL('../template', import.meta.url));
const ENGINE_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENGINE_VERSION = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;

/** Failure print that scripts can see: every ✖ path used to exit 0, so `node index.js mysite && next-step` happily proceeded after a failed scaffold. */
function bail(msg) {
  console.log(msg);
  process.exitCode = 1;
}

/** The command a user should type to run this tool — clone-based reality, not the unpublished npm name. */
const CLI = `node ${join(ENGINE_DIR, 'index.js')}`;

/**
 * The wp.bat shim path, backslash-doubled for templating into JS/JSON
 * source text (`C:\laragon\...` would otherwise render as invalid escape
 * sequences in both). Scaffolded sites get the absolute path because
 * usr\bin is only on PATH when Laragon's "Add to Path" was applied.
 */
const WP_BAT_ESCAPED = join(LARAGON_ROOT, 'usr', 'bin', 'wp.bat').replace(/\\/g, '\\\\');

/**
 * Hand-rolled, no dep — extended from the original katalystwp parser to also
 * accept bare boolean flags (`--yes`, not just `--yes=true`), since several
 * Laragon-specific prompts (root password, "install missing agent?", the UAC
 * wait) need a scriptable bypass the original's `--flag=value`-only parser
 * couldn't express.
 */
export function parseArgs(argv) {
  const out = { command: null, positional: [], flags: {}, yes: false, verbose: false, help: false, version: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') {
      out.yes = true;
      continue;
    }
    if (a === '--verbose') {
      out.verbose = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--version' || a === '-v') {
      out.version = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        out.flags[a.slice(2)] = true;
      }
      continue;
    }
    if (!a.startsWith('-')) {
      out.positional.push(a);
      if (out.command === null) out.command = a;
    }
  }
  return out;
}

/**
 * Cross-process lock for the whole scaffold run — concurrent scaffolds would
 * otherwise trigger competing hosts-file rewrites (each via its own reload)
 * and last-writer-wins registry loss.
 *
 * Self-heals stale locks: Ctrl+C during the multi-minute reload wait (the
 * natural user action) kills the process before any finally runs, and every
 * interrupted run used to cost a manual file deletion. A lock whose recorded
 * pid is DEAD is stolen with a note; a live pid is never stolen, however old
 * the lock. The returned release also detaches the SIGINT handler it
 * installs.
 */
async function acquireScaffoldLock() {
  await mkdir(KATALYST_HOME, { recursive: true });
  const contention = () =>
    new Error(
      `Another scaffold appears to be running (lock at ${SCAFFOLD_LOCK_PATH}).\n` +
        `If nothing is actually running, delete that file and try again.`,
    );
  let handle;
  try {
    handle = await open(SCAFFOLD_LOCK_PATH, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Steal ONLY when the recorded pid is dead. Age alone must not steal —
    // scaffolds legitimately exceed 30 minutes (unattended UAC stall on the
    // hosts write, slow WordPress/plugin downloads), and stealing a live
    // run's lock recreates exactly the concurrent-reload hazard the lock
    // exists to prevent. EPERM from kill(pid, 0) means the process EXISTS
    // (elevated/another session) — that's alive, not dead (same logic as
    // template/scripts/katalyst.mjs's isPidAlive). An unreadable/empty lock
    // that is only seconds old is a concurrent acquirer mid-write, not
    // debris — the open('wx')+writeFile pair isn't atomic.
    let stale = false;
    try {
      const raw = await readFile(SCAFFOLD_LOCK_PATH, 'utf8');
      const lock = JSON.parse(raw);
      let pidAlive;
      try {
        process.kill(lock.pid, 0);
        pidAlive = true;
      } catch (killErr) {
        pidAlive = killErr.code === 'EPERM';
      }
      stale = !pidAlive;
      if (stale) {
        console.log(`  (removing stale scaffold lock from pid ${lock.pid ?? '?'}, started ${lock.startedAt ?? 'unknown'})`);
      }
    } catch {
      const ageMs = Date.now() - (await stat(SCAFFOLD_LOCK_PATH).then((s) => s.mtimeMs).catch(() => 0));
      stale = ageMs > 10_000; // unreadable AND older than the write window — debris
    }
    if (!stale) throw contention();
    await rm(SCAFFOLD_LOCK_PATH, { force: true });
    try {
      handle = await open(SCAFFOLD_LOCK_PATH, 'wx');
    } catch (retakeErr) {
      // Lost the steal race to another process — it holds the lock now.
      if (retakeErr.code === 'EEXIST') throw contention();
      throw retakeErr;
    }
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  await handle.close();
  const onSigint = () => {
    // Sync best-effort: async cleanup isn't guaranteed to run once the
    // process is going down, and a leftover lock costs the next run a steal.
    try {
      rmSync(SCAFFOLD_LOCK_PATH, { force: true });
    } catch {
      // nothing else to do on the way out
    }
    process.exit(130);
  };
  process.on('SIGINT', onSigint);
  return async () => {
    process.removeListener('SIGINT', onSigint);
    await rm(SCAFFOLD_LOCK_PATH, { force: true });
  };
}

let warnedAboutReloadThisSession = false;

/** The one-liner every interrupted-scaffold failure path must end with — resume exists precisely for these states, but nobody finds it in the README mid-failure. Echo --plugins so a retried run doesn't silently drop the original request. */
function resumeHint(name, extraPlugins = []) {
  const pluginsFlag = extraPlugins.length ? ` --plugins=${extraPlugins.join(',')}` : '';
  return `\n  When the site responds again, finish the install with: ${CLI} resume ${name}${pluginsFlag}`;
}

async function confirmScaffold(name, hostname) {
  if (!process.stdin.isTTY) {
    bail(`✖ Not scaffolding: confirm with --yes when running non-interactively.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`? Scaffold a new WordPress site "${name}" at http://${hostname}? [y/N]: `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log('Cancelled.');
    return false;
  }
  return true;
}

/**
 * Detect-only — this tool never spawns a competing Apache process (see
 * laragon.mjs's file header point 5: a raw relaunch DID bring the port back
 * up, but with a stale config that silently 404'd the brand-new site while
 * serving every pre-existing one fine, which is worse than a clear "down").
 * Prints an actionable config-syntax check when Apache genuinely won't come
 * back on its own.
 */
async function reportApacheStillDown(name, hostname, extraPlugins = []) {
  const test = await testApacheConfig();
  bail(
    `✖ Apache is still down.${test.ok === false ? `\n  Config test failed:\n  ${test.output}` : ''}\n` +
      `  Start it in Laragon (Start All), then check http://${hostname} — the folder,\n` +
      '  vhost, and hosts entry this run already produced are left in place.\n' +
      '  (A blank page is normal at this stage — WordPress is not installed yet.)' +
      resumeHint(name, extraPlugins),
  );
}

/**
 * Builds the project in a staging dir, renames it into place, triggers
 * exactly one Laragon reload, and verifies the result with an unspoofable
 * probe token rather than trusting a bare 200 (see laragon.mjs's file header
 * for why: `laragon.exe reload` has repeatedly taken Apache down outright on
 * this machine, and Apache's default vhost 200s ANY unmatched Host). Once
 * the vhost is confirmed correct, provisions a dedicated database and
 * installs WordPress into it.
 */
async function scaffoldSite(name, { flags = {}, yes = false } = {}) {
  const extraPlugins =
    typeof flags.plugins === 'string'
      ? flags.plugins
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const nameErrors = validateSiteName(name);
  if (nameErrors.length) {
    bail(`✖ "${name}" is not a valid site name:`);
    for (const e of nameErrors) console.log(`  - ${e}`);
    return;
  }

  const { collisions, hostname: guessedHostname, projectDir, stagingDir } = await findCollisions(name);
  let hostname = guessedHostname;
  if (collisions.length) {
    bail(`✖ "${name}" is not available:`);
    for (const c of collisions) console.log(`  - ${c}`);
    // The collision list alone nudges people toward deleting folders by
    // hand — say what this state actually is and the command that fixes it.
    const hasFolder = await fileExists(projectDir);
    const hasEnv = hasFolder && (await fileExists(join(projectDir, '.env')));
    const hasSandbox = hasFolder && (await fileExists(join(projectDir, 'sandbox.config.json')));
    if (hasFolder && !hasEnv) {
      const hasVhost = Boolean(await findVhostForProject(projectDir));
      console.log(
        hasVhost
          ? `\n  This looks like an interrupted scaffold — try: ${CLI} resume ${name}`
          : `\n  This looks like an interrupted scaffold with no vhost yet — open Laragon, click\n  Reload, wait for it to settle, then run: ${CLI} resume ${name}`,
      );
    } else if (hasFolder && hasEnv && !hasSandbox) {
      console.log(`\n  This looks like a scaffold that failed near the end — try: ${CLI} resume ${name}`);
    } else if (hasFolder && hasEnv) {
      console.log(`\n  This site already exists. To remove it: cd ${projectDir} then ${CLI} destroy`);
    }
    return;
  }

  const state = await preflight();
  if (!state.laragonInstalled) {
    bail(
      `✖ No laragon.exe found under the resolved Laragon root. If Laragon is installed somewhere\n` +
        '  unusual, set KATALYST_LARAGON_ROOT to its folder (e.g. D:\\laragon) and retry.\n' +
        `  (\`${CLI} doctor\` shows what was resolved.)`,
    );
    return;
  }
  if (!state.laragonRunning) {
    bail('✖ Laragon is not running. Start it and try again (`doctor` will confirm).');
    return;
  }
  if (state.webServer === 'nginx') {
    bail(
      '✖ Laragon is in Nginx mode — this tool currently supports Apache only.\n' +
        '  Switch to Apache in Laragon (Menu ▸ Apache, or Preferences ▸ Services & Ports), then retry.',
    );
    return;
  }
  if (state.webServer === 'foreign') {
    bail(
      "✖ Something other than Laragon's Apache is listening on port 80 (IIS? another Apache?).\n" +
        "  Laragon's own Apache can't start while it is. Stop that service or move it off :80, then retry.",
    );
    return;
  }
  if (!state.apacheUp) {
    bail('✖ Apache is not listening on :80. Start it in Laragon (Start All) and try again.');
    return;
  }

  if (!warnedAboutReloadThisSession) {
    console.log(
      '→ Creating this site will trigger a Laragon reload, which restarts Apache/MySQL for\n' +
        '  EVERY site on this machine, not just this one — expect a brief, machine-wide blip.\n' +
        '  You may also see a Windows permission prompt for the hosts-file update.\n',
    );
    warnedAboutReloadThisSession = true;
  }

  // Explicit gate before any side effect — an unrecognized subcommand falls
  // through to scaffolding, so without this a typo like `node index.js
  // dcotor` would stage a folder and restart Apache machine-wide.
  if (!yes && !(await confirmScaffold(name, hostname))) return;

  const release = await acquireScaffoldLock();
  try {
    console.log(`→ Staging ${name} …`);
    await mkdir(join(stagingDir, 'public'), { recursive: true });
    // public/index.php first, even in staging — `wp core download` (Phase 4)
    // only refuses when it finds wp-load.php, so this placeholder is
    // harmless and gets overwritten by the real WordPress tarball later.
    await writeFile(join(stagingDir, 'public', 'index.php'), '<?php\n// katalyst-laragon placeholder — replaced by `wp core download`\n');
    // Inert when the docroot is public/ (the normal case); saves us if it
    // isn't — see verifyDocroot below.
    await writeFile(join(stagingDir, '.htaccess'), 'Require all denied\n');

    await mkdir(WWW_DIR, { recursive: true });
    await renameWithRetry(stagingDir, projectDir);
    console.log(`✓ Project created at ${projectDir}`);

    await snapshotHosts();
    console.log('→ Reloading Laragon (this can take a while, and may need you to approve a Windows permission prompt)…');
    triggerReload();

    const pollResult = await pollForVhost(projectDir, hostname, {
      onTick: (msg) => console.log(`  … ${msg}`),
    });
    // The vhost conf's own `define SITE` is authoritative over our suffix
    // guess (see pollForVhost) — adopt it for everything downstream.
    if (pollResult.hostname) hostname = pollResult.hostname;

    if (!pollResult.ok && pollResult.reason === 'apache-down') {
      await reportApacheStillDown(name, hostname, extraPlugins);
      return;
    }
    if (!pollResult.ok) {
      bail(
        `✖ Timed out after ${Math.round(pollResult.elapsedMs / 1000)}s waiting for the vhost/hosts entry.\n` +
          `  vhost found: ${pollResult.vhost ? 'yes' : 'no'}  |  hosts entry: ${pollResult.hostsEntry ? 'yes' : 'no'}\n` +
          '  Open Laragon and click Reload yourself, then check http://' +
          hostname +
          ' once it settles.\n' +
          '  (A blank page is normal at this stage — WordPress is not installed yet.)' +
          resumeHint(name, extraPlugins),
      );
      return;
    }

    console.log(`✓ Vhost + hosts entry ready after ${Math.round(pollResult.elapsedMs / 1000)}s`);
    // A short settle delay — Apache has been observed to keep flapping for a
    // while right after a reload rather than crashing once and staying
    // down, so checking the instant the poll succeeds is still a race.
    await sleep(3000);

    let verify = await verifyDocroot(hostname, projectDir);
    if (!verify.ok) {
      // Confirmed live: a conf that's correct AND on disk (pollResult.vhost
      // already proved that) can still 404 because the CURRENTLY RUNNING
      // Apache process's in-memory config predates it — waiting longer does
      // not resolve this on its own (confirmed: 60s of pure patience, no
      // change). Only a fresh reload forces a re-read. Same fix serves the
      // wrong-docroot case (repair the conf first) and this one (the conf's
      // already fine, it just hasn't been loaded) — one retry cycle, capped.
      const outcome = verify.outcome;
      if (outcome === 'wrong-docroot-is-project-root') {
        console.log('→ Docroot points at the project root, not public\\ — repairing…');
        await repairVhost(pollResult.vhost, projectDir);
      } else {
        console.log(`→ Vhost conf is on disk but not serving yet (outcome: ${outcome}) — reloading again…`);
      }
      triggerReload();
      const repoll = await pollForVhost(projectDir, hostname, { timeoutMs: 60_000 });
      if (!repoll.ok) {
        if (repoll.reason === 'apache-down') await reportApacheStillDown(name, hostname, extraPlugins);
        else bail(`✖ Retry reload did not complete (reason: ${repoll.reason}).${resumeHint(name, extraPlugins)}`);
        return;
      }
      await sleep(3000);
      verify = await verifyDocroot(hostname, projectDir);
      if (!verify.ok) {
        const test = await testApacheConfig();
        bail(
          `✖ Still not verifiable after a retry (outcome: ${verify.outcome}).${test.ok === false ? `\n  Config test failed:\n  ${test.output}` : ''}\n` +
            `  The vhost conf is correct on disk at ${pollResult.vhost.file}, but the running Apache\n` +
            '  process hasn\'t picked it up — confirmed live: `reload` alone doesn\'t reliably force a\n' +
            '  real restart once Apache has been up for a while. In Laragon, do a full Stop All then\n' +
            '  Start All (not just Reload), then check http://' +
            hostname +
            '.\n' +
            '  (A blank page is normal at this stage — WordPress is not installed yet.)' +
            resumeHint(name, extraPlugins),
        );
        return;
      }
      console.log('✓ Resolved after the retry reload.');
    }

    console.log(`✓ http://${hostname} is live and serving from public\\`);
    await finishInstall({ name, hostname, projectDir, extraPlugins });
  } catch (err) {
    bail(`✖ Scaffold failed: ${err.message}`);
    await rmWithRetry(stagingDir).catch(() => {});
    if (await fileExists(projectDir)) {
      console.log(
        `  The partly-built site at ${projectDir} was left in place.\n` +
          `  To retry from where it stopped: ${CLI} resume ${name}\n` +
          `  To start over: cd ${projectDir} then ${CLI} destroy, and scaffold again.`,
      );
    }
  } finally {
    await release();
  }
}

/**
 * The DB + WordPress + plugins + MCP + templates + registry pipeline —
 * everything that runs once the vhost is confirmed reachable. Extracted so
 * `resumeCommand` (picking up after an interrupted scaffold — exactly what
 * a Laragon reload staleness failure leaves behind, see laragon.mjs's file
 * header) doesn't need its own copy of this sequence.
 */
async function finishInstall({ name, hostname, projectDir, extraPlugins = [] }) {
  if (!(await mysqlUp())) {
    throw new Error(`MySQL is not listening on :${MYSQL_PORT} — start it in Laragon, then retry.`);
  }
  const cred = await resolveRootCredential();
  if (!cred) {
    throw new Error('Could not resolve MySQL root credentials (tried empty and "root"). Set KATALYST_MYSQL_ROOT_PASSWORD and retry.');
  }

  console.log('→ Creating database…');
  const db = await provisionDatabase(name, cred);
  console.log(`✓ Database ${db.dbName} + user ${db.dbUser} ready`);
  if (db.dbName !== sanitizeDbIdentifier(name, 64)) {
    console.log(`  (note: a previous attempt left a database named ${sanitizeDbIdentifier(name, 64)} — this run uses ${db.dbName}; the old one is unused and safe to drop by hand)`);
  }

  const adminUser = 'admin';
  const adminPassword = generatePassword('wp');
  const adminEmail = 'admin@example.com';

  const wp = await installWordPress({
    projectDir,
    hostname,
    ...db,
    adminUser,
    adminPassword,
    adminEmail,
    siteTitle: name,
    onStep: (msg) => console.log(`  … ${msg}`),
  });

  await writeFile(
    join(projectDir, '.env'),
    [
      `DB_NAME=${db.dbName}`,
      `DB_USER=${db.dbUser}`,
      `DB_PASSWORD=${db.dbPassword}`,
      `DB_HOST=${db.dbHost}`,
      `SITE_HOST=${hostname}`,
      `WP_ADMIN_USER=${adminUser}`,
      `WP_ADMIN_PASSWORD=${adminPassword}`,
      `WP_ADMIN_EMAIL=${adminEmail}`,
      '',
    ].join('\n'),
    'utf8',
  );

  await finishExtras({ name, hostname, projectDir, extraPlugins, adminUser, adminPassword, adminEmail, siteUrl: wp.url });
}

/**
 * Everything after WordPress itself is installed and .env exists: plugins,
 * the Agent Connector pair, premium plugins, MCP wiring, templates,
 * sandbox.config.json, and the registry entry. Split out of finishInstall
 * so `resume` can re-run exactly this half for a site whose .env exists but
 * whose sandbox.config.json doesn't (a scaffold that died in this window) —
 * previously that state was a dead end: resume said "looks fully set up"
 * and re-scaffolding collided. sandbox.config.json is the real completion
 * marker; every step before it is idempotent on re-run.
 */
async function finishExtras({ name, hostname, projectDir, extraPlugins = [], adminUser, adminPassword, adminEmail = 'admin@example.com', siteUrl }) {
  const publicDir = join(projectDir, 'public');
  const onStep = (msg) => console.log(`  … ${msg}`);

  if (extraPlugins.length) {
    await installPlugins({ path: publicDir, plugins: extraPlugins, onStep });
  }

  // Always installed — Phase 7's MCP wiring depends on it, same as the
  // Docker original (which baked it into every scaffold regardless of the
  // user's own plugin selection).
  await installAgentConnector({ path: publicDir, onStep });

  onStep('syncing premium plugins from GitHub…');
  await syncPremiumPluginsFromGitHub({ onStep });
  const premiumPlugins = await installPremiumPlugins({ path: publicDir, onStep });

  onStep('detecting AI agent CLIs…');
  const detected = await detectAgents();
  const configuredAgents = [];
  const detectedKeys = Object.entries(detected)
    .filter(([, resolvedPath]) => resolvedPath)
    .map(([key]) => key);
  if (detectedKeys.length) {
    onStep('minting a WordPress application password for MCP…');
    const appPassword = await mintAppPassword({ path: publicDir, adminUser });
    const creds = { wpApiUrl: `http://${hostname}/wp-json/mcp/mcp-adapter-default-server`, username: adminUser, password: appPassword };
    for (const key of detectedKeys) {
      onStep(`wiring MCP for ${key}…`);
      try {
        await MCP_CONFIGURERS[key](creds);
        configuredAgents.push(key);
      } catch (err) {
        console.log(`  (skipped ${key}: ${err.message})`);
      }
    }
  }

  await copyTemplates(TEMPLATE_DIR, projectDir, {
    PROJECT_NAME: name,
    SITE_HOST: hostname,
    KATALYST_VERSION: ENGINE_VERSION,
    WP_ADMIN_USER: adminUser,
    WP_ADMIN_EMAIL: adminEmail,
    WP_BAT_ESCAPED,
  });

  const sandboxConfigPath = join(projectDir, 'sandbox.config.json');
  const sandboxConfig = JSON.parse(await readFile(sandboxConfigPath, 'utf8'));
  if (extraPlugins.length) sandboxConfig.plugins = extraPlugins;
  if (premiumPlugins.length) sandboxConfig.premiumPlugins = premiumPlugins;
  sandboxConfig.agents = configuredAgents;
  await writeFile(sandboxConfigPath, `${JSON.stringify(sandboxConfig, null, 2)}\n`, 'utf8');

  await recordEnvironment({
    name,
    dir: projectDir,
    hostname,
    port: null,
    agents: configuredAgents,
    createdAt: new Date().toISOString(),
  });

  const adminUrl = await mintAdminLoginUrl({ path: publicDir, hostname });

  console.log(
    `\n✓ WordPress is ready.${configuredAgents.length ? ` MCP wired for: ${configuredAgents.join(', ')}.` : ''}\n` +
      `  Site   ${siteUrl}\n` +
      `  Admin  ${adminUrl}\n` +
      `  User   ${adminUser}\n` +
      `  Pass   ${adminPassword}\n\n` +
      `  cd ${projectDir}\n` +
      '  npm run katalyst   # open the menu\n',
  );
}

/**
 * Picks up a scaffold that got through vhost creation but never finished —
 * exactly the state a Laragon reload staleness failure leaves behind.
 * Unlike scaffoldSite, this never stages/renames or reloads unconditionally;
 * it only confirms the existing vhost is reachable *right now*, then runs
 * the rest of the pipeline. Two distinct entry states:
 *   - no .env yet  → the full finishInstall (DB + WordPress + extras)
 *   - .env but no sandbox.config.json → WordPress is installed but the run
 *     died in the extras window (plugins/MCP/templates); re-run just
 *     finishExtras with the credentials .env already holds. This state used
 *     to be a dead end (resume claimed "fully set up", scaffold collided).
 * sandbox.config.json present = genuinely complete; point at `update`.
 */
async function resumeCommand(name, { flags = {} } = {}) {
  const extraPlugins =
    typeof flags.plugins === 'string'
      ? flags.plugins
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const projectDir = join(WWW_DIR, name);
  if (!(await fileExists(projectDir))) {
    bail(`✖ No folder at ${projectDir} — nothing to resume. Use the normal scaffold command instead.`);
    return;
  }
  const hasEnv = await fileExists(join(projectDir, '.env'));
  const hasSandbox = await fileExists(join(projectDir, 'sandbox.config.json'));
  if (hasEnv && hasSandbox) {
    console.log(`"${name}" is fully set up — nothing to resume. (Use \`update\` from its directory to refresh tooling files.)`);
    return;
  }

  const state = await preflight();
  if (!state.laragonInstalled) {
    bail(
      '✖ No laragon.exe found under the resolved Laragon root. If Laragon is installed somewhere\n' +
        '  unusual, set KATALYST_LARAGON_ROOT to its folder (e.g. D:\\laragon) and retry.',
    );
    return;
  }
  if (!state.laragonRunning) {
    bail('✖ Laragon is not running. Start it and try again.');
    return;
  }
  if (state.webServer === 'nginx') {
    bail('✖ Laragon is in Nginx mode — this tool currently supports Apache only. Switch to Apache in Laragon, then retry.');
    return;
  }
  if (state.webServer === 'foreign') {
    bail("✖ Something other than Laragon's Apache is listening on port 80 (IIS?). Stop it or move it off :80, then retry.");
    return;
  }
  if (!state.apacheUp) {
    bail('✖ Apache is not listening on :80. Start it in Laragon (Start All) and try again.');
    return;
  }

  const vhost = await findVhostForProject(projectDir);
  if (!vhost) {
    // The folder exists (checked above) but Laragon hasn't generated its
    // vhost — an interrupted scaffold killed before the reload finished.
    // Pointing back at the scaffold command would just loop (it collides on
    // the folder and points here); the actual fix is a Laragon reload,
    // which generates vhosts for existing www\ folders.
    bail(
      `✖ No vhost exists yet for ${projectDir}.\n` +
        '  Open Laragon and click Reload (it generates vhosts for folders in www\\), wait for it\n' +
        '  to settle, then retry this same resume command.',
    );
    return;
  }
  const { suffix } = await inferHostnameSuffix();
  const env = hasEnv ? parseEnvFile(await readFile(join(projectDir, '.env'), 'utf8')) : {};
  const hostname = env.SITE_HOST || vhost.hostname || `${name}${suffix}`;
  if (!(await hostsHasEntry(hostname))) {
    bail(`✖ No hosts entry for ${hostname} yet. Open Laragon and click Reload, wait for it to settle, then retry resume.`);
    return;
  }

  console.log('→ Checking the site is reachable…');
  const verify = await verifyDocroot(hostname, projectDir);
  if (!verify.ok) {
    const test = await testApacheConfig();
    bail(
      `✖ Not reachable yet (outcome: ${verify.outcome}).${test.ok === false ? `\n  Config test failed:\n  ${test.output}` : ''}\n` +
        '  In Laragon, do a full Stop All then Start All, then retry resume.',
    );
    return;
  }
  console.log(`✓ http://${hostname} is live and serving from public\\`);

  const release = await acquireScaffoldLock();
  try {
    if (hasEnv) {
      console.log('→ WordPress is already installed — finishing plugins, MCP wiring, and tooling…');
      await finishExtras({
        name,
        hostname,
        projectDir,
        extraPlugins,
        adminUser: env.WP_ADMIN_USER || 'admin',
        adminPassword: env.WP_ADMIN_PASSWORD || '(see .env)',
        adminEmail: env.WP_ADMIN_EMAIL || 'admin@example.com',
        siteUrl: `http://${hostname}`,
      });
    } else {
      await finishInstall({ name, hostname, projectDir, extraPlugins });
    }
  } catch (err) {
    bail(`✖ Resume failed: ${err.message}\n  Safe to retry: ${CLI} resume ${name}`);
  } finally {
    await release();
  }
}

async function listCommand() {
  console.log(formatEnvironmentsTable(await listEnvironments()));
}

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Refreshes only Katalyst-owned files (scripts/, wp-cli.yml, README,
 * .gitignore, package.json's known scripts) — never .env, sandbox.config.json,
 * or anything under public/. Ported policy from the Docker original; the
 * skip-set + package.json merge model is backend-agnostic.
 */
async function updateProject({ yes }) {
  const cwd = process.cwd();
  let envContent;
  try {
    envContent = await readFile(join(cwd, '.env'), 'utf8');
  } catch {
    bail('✖ No .env here — run update from a katalyst-laragon site directory.');
    return;
  }
  // A bare .env is far too common to be the only gate — `update --yes` in
  // any random Node project with a .env used to gut its package.json and
  // overwrite README/.gitignore. Require an actual katalyst marker.
  const isKatalystSite =
    (await fileExists(join(cwd, 'sandbox.config.json'))) || (await fileExists(join(cwd, 'scripts', 'katalyst.mjs')));
  if (!isKatalystSite) {
    bail(
      '✖ This folder has a .env but no sandbox.config.json or scripts\\katalyst.mjs — it does not\n' +
        '  look like a katalyst-laragon site, so update will not touch it.',
    );
    return;
  }
  const env = parseEnvFile(envContent);
  const vars = {
    PROJECT_NAME: basename(cwd),
    SITE_HOST: env.SITE_HOST || 'localhost',
    KATALYST_VERSION: ENGINE_VERSION,
    WP_ADMIN_USER: env.WP_ADMIN_USER || 'admin',
    WP_ADMIN_EMAIL: env.WP_ADMIN_EMAIL || 'admin@example.com',
    WP_BAT_ESCAPED,
  };

  console.log(
    "This refreshes scripts/, wp-cli.yml, .gitignore, README.md, and package.json's known\n" +
      'scripts. Your .env, sandbox.config.json, and any custom package.json scripts are\n' +
      'preserved. If you hand-edited any refreshed file, those edits will be overwritten —\n' +
      'take a backup first (a git commit, or a copy of the folder).',
  );
  if (!yes) {
    if (!process.stdin.isTTY) {
      bail('✖ Not updating: confirm with --yes when running non-interactively.');
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('? I understand — update now [y/N]: ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Cancelled.');
      return;
    }
  }

  await copyTemplates(TEMPLATE_DIR, cwd, vars, { skip: new Set(['package.json', 'sandbox.config.json']) });
  await mergePackageJson(join(TEMPLATE_DIR, 'package.json'), join(cwd, 'package.json'), vars);
  await recordEnvironment({ dir: cwd, updatedAt: new Date().toISOString() });
  console.log(`✓ Updated to v${ENGINE_VERSION}.`);
}

/**
 * Run from within a site directory (like `update`). Order matters — see
 * destroy.mjs's own header for why MCP/app-password cleanup must happen
 * before the database is dropped, and the database before the vhost/folder.
 */
async function destroyCommand({ yes }) {
  const cwd = process.cwd();
  if (!(await fileExists(join(cwd, '.env')))) {
    bail('✖ No .env here — run destroy from a katalyst-laragon site directory.');
    return;
  }
  console.log(
    `This permanently removes ${cwd}:\n` +
      '  - the database and its dedicated user\n' +
      '  - the WordPress application password this tool minted\n' +
      '  - MCP registrations for any agents this site configured\n' +
      '  - the vhost conf and this project directory\n' +
      "This does NOT remove the site's hosts entry (this tool never writes hosts directly) —\n" +
      "the line will be printed at the end so you can remove it by hand, or leave it; Laragon's\n" +
      'own reload prunes entries for folders that no longer exist.\n' +
      'This cannot be undone.',
  );
  if (!yes) {
    if (!process.stdin.isTTY) {
      bail('✖ Not destroying: confirm with --yes when running non-interactively.');
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('? Type the site name to confirm: ');
    rl.close();
    if (answer.trim() !== basename(cwd)) {
      console.log('Cancelled.');
      return;
    }
  }

  const result = await destroySite({ projectDir: cwd, onStep: (msg) => console.log(`  … ${msg}`) });
  await forgetEnvironment(cwd);

  console.log(
    `\n✓ Destroyed.${result.removedAgents.length ? ` MCP entries removed for: ${result.removedAgents.join(', ')}.` : ''}` +
      `${result.dbDropped ? ' Database dropped.' : ` (database not dropped: ${result.dbSkipReason})`}\n` +
      (result.hostname ? `\nRemaining trace: a hosts entry for ${result.hostname} — safe to leave, or remove by hand.\n` : ''),
  );
  if (!result.dbDropped && result.dbSkipReason !== 'no database recorded in .env') process.exitCode = 1;
}

async function fileExists(p) {
  // stat, not readFile — readFile throws EISDIR on a directory, which would
  // report an existing project folder as "missing".
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function registerQuickAppCommand() {
  const result = await registerQuickApp();
  if (!result.added) {
    console.log(`Not added: ${result.reason}.`);
    return;
  }
  console.log(
    `✓ Added a "KatalystWP" entry to sites.conf (backed up to ${result.backup}).\n` +
      'Reopen Laragon\'s tray menu (Quick app) to see it. Note: Quick app\'s own AutoCreateDatabase\n' +
      "will also create a plain DB named after the project — this tool's own DB (a differently-\n" +
      'named, dedicated user) is what the site actually uses; the Quick-app-created one is unused\n' +
      'and safe to drop by hand.',
  );
}

function printUsage() {
  console.log(`
create-katalyst-laragon v${ENGINE_VERSION} — local WordPress + AI-agent dev environments on Laragon

From this tool's checkout (${ENGINE_DIR}):

  node index.js doctor              Check this machine's Laragon/PHP/MySQL/Node state
  node index.js <name>              Scaffold a WordPress site at http://<name>.test (or your Laragon suffix)
  node index.js resume <name>       Finish an interrupted scaffold (vhost already up)
  node index.js list                List scaffolded sites
  node index.js register-quick-app  Add a Laragon Quick app entry for this tool

From inside a scaffolded site's directory (using the full path to this checkout):

  ${CLI} update      Refresh Katalyst's own tooling files
  ${CLI} destroy     Permanently remove that site

Flags: --yes/-y  --help/-h  --version/-v  --plugins=slug1,slug2  (wordpress.org slugs or .zip URLs)
Env:   KATALYST_LARAGON_ROOT  KATALYST_MYSQL_ROOT_PASSWORD  KATALYST_MYSQL_PORT  KATALYST_PREMIUM_PLUGINS_REPO
`);
}

const KNOWN_FLAGS = new Set(['plugins']);
const KNOWN_COMMANDS = new Set(['doctor', 'list', 'resume', 'update', 'destroy', 'register-quick-app', 'help', 'version']);

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Anything not a known command becomes a SITE NAME and scaffolds — warn when it smells like a typo'd command instead. */
function closestCommand(word) {
  for (const cmd of KNOWN_COMMANDS) {
    if (editDistance(word.toLowerCase(), cmd) <= 2 && word.toLowerCase() !== cmd) return cmd;
  }
  return null;
}

export async function create({ argv = process.argv.slice(2) } = {}) {
  const args = parseArgs(argv);

  for (const flag of Object.keys(args.flags)) {
    if (!KNOWN_FLAGS.has(flag)) {
      const hint = flag === 'plugin' ? ' (did you mean --plugins?)' : '';
      console.log(`⚠ Unknown flag --${flag}${hint} — ignoring it.`);
    }
  }

  if (args.version) {
    console.log(`create-katalyst-laragon v${ENGINE_VERSION}`);
    return;
  }

  if (args.help || args.command === 'help') {
    printUsage();
    return;
  }

  if (args.command === 'version') {
    console.log(`create-katalyst-laragon v${ENGINE_VERSION}`);
    return;
  }

  if (args.command === 'doctor') {
    await runDoctor();
    return;
  }

  if (args.command === 'list') {
    await listCommand();
    return;
  }

  if (args.command === 'resume') {
    const name = args.positional[1];
    if (!name) {
      bail(`✖ Usage: ${CLI} resume <name>`);
      return;
    }
    await resumeCommand(name, { flags: args.flags });
    return;
  }

  if (args.command === 'update') {
    await updateProject({ yes: args.yes });
    return;
  }

  if (args.command === 'destroy') {
    await destroyCommand({ yes: args.yes });
    return;
  }

  if (args.command === 'register-quick-app') {
    await registerQuickAppCommand();
    return;
  }

  if (args.command) {
    const close = closestCommand(args.command);
    if (close) {
      console.log(`⚠ "${args.command}" looks like a mistyped command (did you mean "${close}"?) — treating it as a SITE NAME to scaffold.`);
    }
    await scaffoldSite(args.command, { flags: args.flags, yes: args.yes });
    return;
  }

  printUsage();
}
