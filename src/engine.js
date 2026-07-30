import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor } from './doctor.mjs';
import { KATALYST_HOME, SCAFFOLD_LOCK_PATH, WWW_DIR } from './paths.mjs';
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
import { provisionDatabase, resolveRootCredential } from './mysql.mjs';
import { installWordPress } from './wordpress.mjs';
import { generatePassword } from './secrets.mjs';
import { copyTemplates, mergePackageJson } from './templates.mjs';
import { formatEnvironmentsTable, forgetEnvironment, listEnvironments, recordEnvironment } from './registry.mjs';
import { installAgentConnector, installPlugins } from './plugins.mjs';
import { detectAgents } from './agents.mjs';
import { mintAppPassword, MCP_CONFIGURERS } from './mcp.mjs';
import { mintAdminLoginUrl } from './admin-login.mjs';
import { destroySite } from './destroy.mjs';
import { registerQuickApp } from './quickapp.mjs';

const TEMPLATE_DIR = fileURLToPath(new URL('../template', import.meta.url));
const ENGINE_VERSION = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;

/**
 * Hand-rolled, no dep — extended from the original katalystwp parser to also
 * accept bare boolean flags (`--yes`, not just `--yes=true`), since several
 * Laragon-specific prompts (root password, "install missing agent?", the UAC
 * wait) need a scriptable bypass the original's `--flag=value`-only parser
 * couldn't express.
 */
export function parseArgs(argv) {
  const out = { command: null, positional: [], flags: {}, yes: false, verbose: false, help: false };
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
 */
async function acquireScaffoldLock() {
  await mkdir(KATALYST_HOME, { recursive: true });
  let handle;
  try {
    handle = await open(SCAFFOLD_LOCK_PATH, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(
        `Another scaffold appears to be running (lock at ${SCAFFOLD_LOCK_PATH}).\n` +
          `If nothing is actually running, delete that file and try again.`,
      );
    }
    throw err;
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  await handle.close();
  return async () => rm(SCAFFOLD_LOCK_PATH, { force: true });
}

let warnedAboutReloadThisSession = false;

/**
 * Detect-only — this tool never spawns a competing Apache process (see
 * laragon.mjs's file header point 5: a raw relaunch DID bring the port back
 * up, but with a stale config that silently 404'd the brand-new site while
 * serving every pre-existing one fine, which is worse than a clear "down").
 * Prints an actionable config-syntax check when Apache genuinely won't come
 * back on its own.
 */
async function reportApacheStillDown() {
  const test = await testApacheConfig();
  console.log(
    `✖ Apache is still down.${test.ok === false ? `\n  Config test failed:\n  ${test.output}` : ''}\n` +
      '  Start it in Laragon (Start All), then check http://<hostname> yourself — the folder,\n' +
      '  vhost, and hosts entry this run already produced are left in place.',
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
async function scaffoldSite(name, { flags = {} } = {}) {
  const extraPlugins =
    typeof flags.plugins === 'string'
      ? flags.plugins
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const nameErrors = validateSiteName(name);
  if (nameErrors.length) {
    console.log(`✖ "${name}" is not a valid site name:`);
    for (const e of nameErrors) console.log(`  - ${e}`);
    return;
  }

  const { collisions, hostname, projectDir, stagingDir } = await findCollisions(name);
  if (collisions.length) {
    console.log(`✖ "${name}" is not available:`);
    for (const c of collisions) console.log(`  - ${c}`);
    return;
  }

  const state = await preflight();
  if (!state.laragonRunning) {
    console.log('✖ Laragon is not running. Start it and try again (`doctor` will confirm).');
    return;
  }
  if (!state.apacheUp) {
    console.log('✖ Apache is not listening on :80. Start it in Laragon (Start All) and try again.');
    return;
  }

  if (!warnedAboutReloadThisSession) {
    console.log(
      '→ Creating this site will trigger a Laragon reload, which restarts Apache/MySQL for\n' +
        '  EVERY site on this machine, not just this one — expect a brief, machine-wide blip.\n',
    );
    warnedAboutReloadThisSession = true;
  }

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

    if (!pollResult.ok && pollResult.reason === 'apache-down') {
      await reportApacheStillDown();
      return;
    }
    if (!pollResult.ok) {
      console.log(
        `✖ Timed out after ${Math.round(pollResult.elapsedMs / 1000)}s waiting for the vhost/hosts entry.\n` +
          `  vhost found: ${pollResult.vhost ? 'yes' : 'no'}  |  hosts entry: ${pollResult.hostsEntry ? 'yes' : 'no'}\n` +
          '  Open Laragon and click Reload yourself, then check http://' +
          hostname +
          ' once it settles.',
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
        if (repoll.reason === 'apache-down') await reportApacheStillDown();
        else console.log(`✖ Retry reload did not complete (reason: ${repoll.reason}).`);
        return;
      }
      await sleep(3000);
      verify = await verifyDocroot(hostname, projectDir);
      if (!verify.ok) {
        const test = await testApacheConfig();
        console.log(
          `✖ Still not verifiable after a retry (outcome: ${verify.outcome}).${test.ok === false ? `\n  Config test failed:\n  ${test.output}` : ''}\n` +
            `  The vhost conf is correct on disk at ${pollResult.vhost.file}, but the running Apache\n` +
            '  process hasn\'t picked it up — confirmed live: `reload` alone doesn\'t reliably force a\n' +
            '  real restart once Apache has been up for a while. In Laragon, do a full Stop All then\n' +
            '  Start All (not just Reload), then check http://' +
            hostname +
            '.',
        );
        return;
      }
      console.log('✓ Resolved after the retry reload.');
    }

    console.log(`✓ http://${hostname} is live and serving from public\\`);
    await finishInstall({ name, hostname, projectDir, extraPlugins });
  } catch (err) {
    console.error(`✖ Scaffold failed: ${err.message}`);
    await rmWithRetry(stagingDir).catch(() => {});
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
    throw new Error('MySQL is not listening on :3306 — start it in Laragon, then retry.');
  }
  const cred = await resolveRootCredential();
  if (!cred) {
    throw new Error('Could not resolve MySQL root credentials (tried empty and "root"). Set KATALYST_MYSQL_ROOT_PASSWORD and retry.');
  }

  console.log('→ Creating database…');
  const db = await provisionDatabase(name, cred);
  console.log(`✓ Database ${db.dbName} + user ${db.dbUser} ready`);

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

  const publicDir = join(projectDir, 'public');
  const onStep = (msg) => console.log(`  … ${msg}`);

  if (extraPlugins.length) {
    await installPlugins({ path: publicDir, plugins: extraPlugins, onStep });
  }

  // Always installed — Phase 7's MCP wiring depends on it, same as the
  // Docker original (which baked it into every scaffold regardless of the
  // user's own plugin selection).
  await installAgentConnector({ path: publicDir, onStep });

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
  });

  const sandboxConfigPath = join(projectDir, 'sandbox.config.json');
  const sandboxConfig = JSON.parse(await readFile(sandboxConfigPath, 'utf8'));
  if (extraPlugins.length) sandboxConfig.plugins = extraPlugins;
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
      `  Site   ${wp.url}\n` +
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
 * the same finishInstall pipeline. If the vhost isn't reachable yet, it
 * says so and leaves the retry to the user — resume's job is to pick up
 * from a working vhost, not re-run the vhost dance.
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
    console.log(`✖ No folder at ${projectDir} — nothing to resume. Use the normal scaffold command instead.`);
    return;
  }
  if (await fileExists(join(projectDir, '.env'))) {
    console.log(`"${name}" already has a .env — it looks fully set up. Nothing to resume (use \`update\` to refresh tooling files).`);
    return;
  }

  const state = await preflight();
  if (!state.laragonRunning) {
    console.log('✖ Laragon is not running. Start it and try again.');
    return;
  }
  if (!state.apacheUp) {
    console.log('✖ Apache is not listening on :80. Start it in Laragon (Start All) and try again.');
    return;
  }

  const vhost = await findVhostForProject(projectDir);
  if (!vhost) {
    console.log(`✖ No vhost found for ${projectDir} — this doesn't look like an interrupted scaffold. Use the normal scaffold command instead.`);
    return;
  }
  const { suffix } = await inferHostnameSuffix();
  const hostname = vhost.hostname || `${name}${suffix}`;
  if (!(await hostsHasEntry(hostname))) {
    console.log(`✖ No hosts entry for ${hostname} yet. Open Laragon and click Reload, wait for it to settle, then retry resume.`);
    return;
  }

  console.log('→ Checking the site is reachable…');
  const verify = await verifyDocroot(hostname, projectDir);
  if (!verify.ok) {
    const test = await testApacheConfig();
    console.log(
      `✖ Not reachable yet (outcome: ${verify.outcome}).${test.ok === false ? `\n  Config test failed:\n  ${test.output}` : ''}\n` +
        '  In Laragon, do a full Stop All then Start All, then retry resume.',
    );
    return;
  }
  console.log(`✓ http://${hostname} is live and serving from public\\`);

  const release = await acquireScaffoldLock();
  try {
    await finishInstall({ name, hostname, projectDir, extraPlugins });
  } catch (err) {
    console.error(`✖ Resume failed: ${err.message}`);
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
    console.log('✖ No .env here — run update from a katalyst-laragon site directory.');
    return;
  }
  const env = parseEnvFile(envContent);
  const vars = {
    PROJECT_NAME: basename(cwd),
    SITE_HOST: env.SITE_HOST || 'localhost',
    KATALYST_VERSION: ENGINE_VERSION,
    WP_ADMIN_USER: env.WP_ADMIN_USER || 'admin',
    WP_ADMIN_EMAIL: env.WP_ADMIN_EMAIL || 'admin@example.com',
  };

  console.log(
    "This refreshes scripts/, wp-cli.yml, .gitignore, README.md, and package.json's known\n" +
      'scripts. Your .env, sandbox.config.json, and any custom package.json scripts are\n' +
      'preserved. If you hand-edited any refreshed file, those edits will be overwritten —\n' +
      'take a backup first (a git commit, or a copy of the folder).',
  );
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error('✖ Not updating: confirm with --yes when running non-interactively.');
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
    console.log('✖ No .env here — run destroy from a katalyst-laragon site directory.');
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
      console.error('✖ Not destroying: confirm with --yes when running non-interactively.');
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
      `${result.dbDropped ? ' Database dropped.' : ' (no database to drop — .env had none)'}\n` +
      (result.hostname ? `\nRemaining trace: a hosts entry for ${result.hostname} — safe to leave, or remove by hand.\n` : ''),
  );
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
    console.log(`Already registered (${result.reason}).`);
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
create-katalyst-laragon — local WordPress + AI-agent dev environments on Laragon

  npx create-katalyst-laragon doctor            Check this machine's Laragon/PHP/MySQL/Node state
  npx create-katalyst-laragon <name>             Scaffold a WordPress site on Laragon
  npx create-katalyst-laragon resume <name>      Finish an interrupted scaffold (vhost already up)
  npx create-katalyst-laragon list               List scaffolded sites
  npx create-katalyst-laragon update             Refresh Katalyst's own tooling (run from a site dir)
  npx create-katalyst-laragon destroy            Permanently remove a site (run from its directory)
  npx create-katalyst-laragon register-quick-app Add a Laragon Quick app entry for this tool

Flags: --yes/-y  --verbose  --help/-h  --plugins=slug1,slug2  (wordpress.org slugs or .zip URLs)
`);
}

export async function create({ argv = process.argv.slice(2) } = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
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
      console.log('✖ Usage: create-katalyst-laragon resume <name>');
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
    await scaffoldSite(args.command, { flags: args.flags });
    return;
  }

  printUsage();
}
