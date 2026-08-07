import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { banner, cyan, dim, green, red, yellow, BAD, OK, STEP, WARN } from './ansi.mjs';
import { runDoctor } from './doctor.mjs';
import { AGENTPRESS_HOME, LARAGON_ROOT, REGISTRY_PATH, SCAFFOLD_LOCK_PATH, WWW_DIR } from './paths.mjs';
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
import { diagnoseAppPasswordAuth, ensureHtaccessGuardBlock, installWordPress, writeMcpLoopbackGuard } from './wordpress.mjs';
import { generatePassword } from './secrets.mjs';
import { copyTemplates, mergePackageJson } from './templates.mjs';
import { formatEnvironmentsTable, forgetEnvironment, listEnvironments, recordEnvironment } from './registry.mjs';
import { applyLicenses, installAgentConnector, installPlugins, installPremiumPlugins, patchOxygenHtmlToPage, premiumPluginAvailability, syncPremiumPluginsFromGitHub, updateAllPlugins } from './plugins.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { AGENT_LABELS, detectAgents } from './agents.mjs';
import { mintAppPassword, readWiredHostnames, verifyMcpEndpoint, MCP_CONFIGURERS } from './mcp.mjs';
import { mintAdminLoginUrl } from './admin-login.mjs';
import { destroySite } from './destroy.mjs';
import { registerQuickApp } from './quickapp.mjs';
import { ensureHostsEntry, fetchViaLoopback, flushDnsCache, installWildcardConf, sslCertPresent, wildcardActive, wildcardConfInstalled, WILDCARD_CONF_PATH } from './wildcard.mjs';
import { randomBytes } from 'node:crypto';

const TEMPLATE_DIR = fileURLToPath(new URL('../template', import.meta.url));
const ENGINE_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENGINE_VERSION = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;

/** Failure print that scripts can see: every ✖ path used to exit 0, so `node index.js mysite && next-step` happily proceeded after a failed scaffold. */
function bail(msg) {
  console.log(msg);
  process.exitCode = 1;
}

/**
 * The command a user should type to run this tool. When running out of an
 * npm/npx installation (node_modules in our own path), the durable
 * invocation is the package name — the npx cache path we're executing from
 * is ephemeral and must never be printed as advice. From a git clone, the
 * checkout path is the right thing.
 */
const RUNNING_FROM_PACKAGE = /[\\/]node_modules[\\/]/i.test(ENGINE_DIR);
const CLI = RUNNING_FROM_PACKAGE ? 'npx create-agentpress' : `node ${join(ENGINE_DIR, 'index.js')}`;

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
  await mkdir(AGENTPRESS_HOME, { recursive: true });
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
    // template/scripts/agentpress.mjs's isPidAlive). An unreadable/empty lock
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

/**
 * Echo BOTH selection flags: a bare `resume` defaults premium plugins to
 * "every available zip", so a printed command that dropped --premium would
 * install commercial plugins the user had just declined. (The pending-selection
 * file written at staging time covers the same ground for anyone who types
 * `resume` from memory instead of copying this line.) `--premium=` is emitted
 * only when a selection was actually resolved — `null` means we failed before
 * that point, where staying silent and letting resume's own default apply is
 * right.
 */
function resumeCommandLine(name, extraPlugins = [], premiumSelection = null) {
  const pluginsFlag = extraPlugins.length ? ` --plugins=${extraPlugins.join(',')}` : '';
  const premiumFlag = Array.isArray(premiumSelection)
    ? ` --premium=${premiumSelection.length ? premiumSelection.join(',') : 'none'}`
    : '';
  return `${CLI} resume ${name}${pluginsFlag}${premiumFlag}`;
}

/** The one-liner every interrupted-scaffold failure path must end with — resume exists precisely for these states, but nobody finds it in the README mid-failure. */
function resumeHint(name, extraPlugins = [], premiumSelection = null) {
  return `\n  When the site responds again, finish the install with: ${resumeCommandLine(name, extraPlugins, premiumSelection)}`;
}

/**
 * The scaffold's resolved selections, parked in the project directory so an
 * interrupted run can be finished with the SAME choices. Deleted once the
 * site is complete, so its presence also marks "this scaffold never finished".
 */
const PENDING_SELECTION_FILE = '.agentpress-pending.json';

async function readPendingSelection(projectDir) {
  const path = join(projectDir, PENDING_SELECTION_FILE);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { plugins: null, premium: null }; // never parked, or already cleaned up
  }
  try {
    const raw = JSON.parse(text);
    return {
      plugins: Array.isArray(raw.plugins) ? raw.plugins.filter((s) => typeof s === 'string') : null,
      premium: Array.isArray(raw.premium) ? raw.premium.filter((s) => typeof s === 'string') : null,
    };
  } catch (err) {
    // A file that EXISTS but cannot be parsed is not the same as "nothing was
    // parked": silently falling back would install every available premium
    // plugin while the user believes their original choice is being honoured.
    console.log(
      `${yellow(WARN)} ${path} is unreadable (${err.message}) — cannot tell what this scaffold originally chose.\n` +
        '  Pass --premium= explicitly if it matters; otherwise every available premium plugin is installed.',
    );
    return { plugins: null, premium: null };
  }
}

/**
 * Per-PROJECT premium plugin selection — some projects need WooCommerce,
 * most don't, so the choice belongs at scaffold time, not machine setup.
 * Resolution order: --premium=slug1,slug2 | all | none (scripted runs) →
 * interactive picker (available zips default Yes) → non-interactive default
 * of "all available". Choosing an extension pulls Oxygen in with it — the
 * extensions are inert without the builder.
 */
async function choosePremiumPlugins({ flagValue, yes }) {
  const availability = await premiumPluginAvailability();
  const available = availability.filter((p) => p.available);

  if (typeof flagValue === 'string') {
    const value = flagValue.trim().toLowerCase();
    if (value === 'none') return [];
    if (value === 'all') return available.map((p) => p.slug);
    const requested = value.split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set(availability.map((p) => p.slug));
    const selection = requested.filter((s) => {
      if (!known.has(s)) {
        console.log(`${yellow(WARN)} Unknown premium plugin "${s}" in --premium — ignoring it.`);
        return false;
      }
      return true;
    });
    if (selection.some((s) => s.startsWith('breakdance-')) && !selection.includes('oxygen')) selection.unshift('oxygen');
    return selection;
  }

  if (yes || !process.stdin.isTTY) return available.map((p) => p.slug);

  if (!available.length) {
    console.log(`  (no premium plugin zips on this machine — run \`${CLI} setup\` to add them; continuing without)`);
    return [];
  }

  console.log('\nWhich premium plugins should THIS project get?');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const selection = [];
  try {
    for (const plugin of availability) {
      if (!plugin.available) {
        console.log(`  ${red(BAD)} ${plugin.label} — no zip on this machine (run setup to add it), skipping`);
        continue;
      }
      const answer = (await rl.question(`  Install ${plugin.label}? [Y/n]: `)).trim();
      if (answer === '' || /^y(es)?$/i.test(answer)) selection.push(plugin.slug);
    }
  } finally {
    rl.close();
  }
  if (selection.some((s) => s.startsWith('breakdance-')) && !selection.includes('oxygen')) {
    const oxygen = available.find((p) => p.slug === 'oxygen');
    if (oxygen) {
      console.log('  (adding Oxygen Builder — the selected extensions need it)');
      selection.unshift('oxygen');
    }
  }
  return selection;
}

async function confirmScaffold(name, hostname) {
  if (!process.stdin.isTTY) {
    bail(`${red(BAD)} Not scaffolding: confirm with --yes when running non-interactively.`);
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
 * Instant-mode reachability probe: serve a token from the site's public/
 * through the wildcard vhost, over the loopback with an explicit Host
 * header — no DNS, no hosts-entry dependency, no per-site vhost. Replaces
 * verifyDocroot's dual-request dance (wrong-docroot is impossible when the
 * wildcard derives the docroot by convention).
 */
async function probeInstant(hostname, projectDir, { timeoutMs = 12_000 } = {}) {
  const token = randomBytes(12).toString('hex');
  const probeFile = join(projectDir, 'public', '.agentpress-probe.txt');
  await writeFile(probeFile, token, 'utf8');
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await fetchViaLoopback(hostname, '/.agentpress-probe.txt');
      if (res && res.status === 200 && res.body.trim() === token) return true;
      await sleep(750);
    }
    return false;
  } finally {
    await rm(probeFile, { force: true }).catch(() => {});
  }
}

/**
 * The project root holds `.env` (DB + admin passwords). It sits OUTSIDE the
 * site's own docroot (`public/`), so the site's own vhost can never serve
 * it — but Laragon's default catch-all vhost serves the whole `www\` tree by
 * path, which makes `http://127.0.0.1/<name>/.env` reachable, and Apache
 * binds every interface. `Require all denied` in the project root closes
 * that path (Apache reads it for the default vhost, and never for the site
 * itself since it is above that docroot).
 *
 * Written from HERE — the same function that writes `.env` — not from the
 * staging block, so `resume` and any future path that creates `.env` are
 * covered too. Then VERIFIED rather than assumed: the guard's effectiveness
 * depends on a Laragon conf we do not own granting AllowOverride, so a
 * silent regression would leak credentials to anything on the network.
 */
async function protectProjectSecrets({ name, projectDir }) {
  await writeFile(
    join(projectDir, '.htaccess'),
    '# Denies the project ROOT over HTTP. .env (DB + admin passwords) lives here,\n' +
      "# and Laragon's default vhost serves the whole www\\ tree by path. Apache never\n" +
      '# reads this file when serving the site itself (public/ is the docroot).\n' +
      'Require all denied\n',
    'utf8',
  );
  const res = await fetchViaLoopback('127.0.0.1', `/${encodeURIComponent(name)}/.env`, { timeoutMs: 4000 });
  if (res && res.status === 200 && /DB_PASSWORD|WP_ADMIN_PASSWORD/.test(res.body)) {
    console.log(
      `\n${yellow(WARN)} SECURITY: ${join(projectDir, '.env')} is being served over HTTP\n` +
        `  (http://127.0.0.1/${name}/.env returned its contents — it holds this site's DB and\n` +
        "  admin passwords, and Apache listens on every interface). The protective .htaccess was\n" +
        "  written but Laragon's Apache is ignoring it (AllowOverride None for www\\).\n" +
        '  Fix: add `AllowOverride All` for the www directory in Laragon\'s Apache config, or move\n' +
        '  this site out of a world-served tree, before using this site on an untrusted network.\n',
    );
    return false;
  }
  return true;
}

/** Warn-only wrapper around the elevated hosts write — a declined UAC must never sink the scaffold, since WordPress installation itself needs no DNS. */
async function ensureHostsEntryWithGuidance(hostname) {
  console.log(`${cyan(STEP)} Adding the hosts entry (a Windows permission prompt may appear — approve it)…`);
  const result = await ensureHostsEntry(hostname);
  if (result.ok) {
    console.log(result.already ? `${green(OK)} hosts entry already present` : `${green(OK)} hosts entry added`);
  } else {
    console.log(
      `${yellow(WARN)} Could not write the hosts entry (${result.reason}).\n` +
        `  The install will still complete, but the browser/MCP need this line in\n` +
        `  ${join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')}:\n` +
        `    127.0.0.1\t${hostname}\n` +
        '  Add it by hand (as admin), or click Reload in Laragon once — it syncs hosts too.',
    );
  }
  return result.ok;
}

/**
 * Detect-only — this tool never spawns a competing Apache process (see
 * laragon.mjs's file header point 5: a raw relaunch DID bring the port back
 * up, but with a stale config that silently 404'd the brand-new site while
 * serving every pre-existing one fine, which is worse than a clear "down").
 * Prints an actionable config-syntax check when Apache genuinely won't come
 * back on its own.
 */
async function reportApacheStillDown(name, hostname, extraPlugins = [], premiumSelection = null) {
  const test = await testApacheConfig();
  bail(
    `${red(BAD)} Apache is still down.${test.ok === false ? `\n  Config test failed:\n  ${test.output}` : ''}\n` +
      `  Start it in Laragon (Start All), then check http://${hostname} — the folder,\n` +
      '  vhost, and hosts entry this run already produced are left in place.\n' +
      '  (A blank page is normal at this stage — WordPress is not installed yet.)' +
      resumeHint(name, extraPlugins, premiumSelection),
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
    bail(`${red(BAD)} "${name}" is not a valid site name:`);
    for (const e of nameErrors) console.log(`  - ${e}`);
    return;
  }

  const { collisions, kinds, hostname: guessedHostname, projectDir, stagingDir } = await findCollisions(name);
  let hostname = guessedHostname;
  if (collisions.length) {
    bail(`${red(BAD)} "${name}" is not available:`);
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
    } else {
      // No folder, so none of the resume/destroy advice applies. Offer ONLY the
      // remedies whose surface actually fired: a blanket "delete the conf named
      // above" is actively dangerous, because the conf named above may be
      // another LIVE project's vhost (kinds.hostnameOwnedElsewhere), where the
      // correct action is renaming this site, not deleting their config.
      const remedies = [];
      if (kinds.registry) remedies.push(`    - registry entry: remove "${name}" from ${REGISTRY_PATH}`);
      if (kinds.vhostUnderProject) remedies.push("    - leftover vhost for THIS project: delete the conf named above, then Reload in Laragon");
      if (kinds.staging) remedies.push(`    - staging dir: delete ${stagingDir}`);
      if (kinds.hostnameOwnedElsewhere) {
        remedies.push('    - hostname taken by another site: scaffold under a different name (leave that conf alone)');
      }
      if (kinds.foreignHostsEntry) remedies.push('    - hosts entry: remove the line named above (as administrator)');
      console.log(
        `\n  There is no folder at ${projectDir}, so nothing of this site exists to resume.` +
          (remedies.length
            ? `\n  ${remedies.length > 1 ? 'Clear whichever applies, then retry' : 'Next step'}:\n${remedies.join('\n')}`
            : ''),
      );
    }
    return;
  }

  const state = await preflight();
  if (!state.laragonInstalled) {
    bail(
      `${red(BAD)} No laragon.exe found under the resolved Laragon root. If Laragon is installed somewhere\n` +
        '  unusual, set AGENTPRESS_LARAGON_ROOT to its folder (e.g. D:\\laragon) and retry.\n' +
        `  (\`${CLI} doctor\` shows what was resolved.)`,
    );
    return;
  }
  if (!state.laragonRunning) {
    bail(`${red(BAD)} Laragon is not running. Start it and try again (\`doctor\` will confirm).`);
    return;
  }
  if (state.webServer === 'nginx') {
    bail(
      `${red(BAD)} Laragon is in Nginx mode — this tool currently supports Apache only.\n` +
        '  Switch to Apache in Laragon (Menu ▸ Apache, or Preferences ▸ Services & Ports), then retry.',
    );
    return;
  }
  if (state.webServer === 'foreign') {
    bail(
      `${red(BAD)} Something other than Laragon's Apache is listening on port 80 (IIS? another Apache?).\n` +
        "  Laragon's own Apache can't start while it is. Stop that service or move it off :80, then retry.",
    );
    return;
  }
  if (!state.apacheUp) {
    bail(`${red(BAD)} Apache is not listening on :80. Start it in Laragon (Start All) and try again.`);
    return;
  }

  // Instant mode: the one-time wildcard vhost serves <name>/public by
  // convention, so this scaffold needs no Laragon reload at all. Activity
  // is PROVEN by a live probe (conf-on-disk ≠ conf-in-Apache until the
  // one-time restart happened).
  const instant = wildcardConfInstalled() && (await wildcardActive());
  if (wildcardConfInstalled() && !instant) {
    console.log(
      `${yellow(WARN)} Instant mode is installed but not active yet (Apache has not restarted since setup).\n` +
        '  Falling back to the classic Laragon-reload flow for this scaffold. One-time fix:\n' +
        '  Stop All → Start All in Laragon, and every future scaffold skips reloads entirely.\n',
    );
  } else if (!wildcardConfInstalled()) {
    console.log(`  Tip: run \`${CLI} setup\` once to enable instant scaffolds (no more Laragon reloads).\n`);
  }

  if (!instant && !warnedAboutReloadThisSession) {
    console.log(
      `${cyan(STEP)} Creating this site will trigger a Laragon reload, which restarts Apache/MySQL for\n` +
        '  EVERY site on this machine, not just this one — expect a brief, machine-wide blip.\n' +
        '  You may also see a Windows permission prompt for the hosts-file update.\n',
    );
    warnedAboutReloadThisSession = true;
  }

  // Explicit gate before any side effect — an unrecognized subcommand falls
  // through to scaffolding, so without this a typo like `node index.js
  // dcotor` would stage a folder and restart Apache machine-wide.
  if (!yes && !(await confirmScaffold(name, hostname))) return;

  const premiumSelection = await choosePremiumPlugins({ flagValue: typeof flags.premium === 'string' ? flags.premium : undefined, yes });

  const release = await acquireScaffoldLock();
  try {
    console.log(`${cyan(STEP)} Staging ${name} …`);
    await mkdir(join(stagingDir, 'public'), { recursive: true });
    // public/index.php first, even in staging — `wp core download` (Phase 4)
    // only refuses when it finds wp-load.php, so this placeholder is
    // harmless and gets overwritten by the real WordPress tarball later.
    await writeFile(join(stagingDir, 'public', 'index.php'), '<?php\n// agentpress placeholder — replaced by `wp core download`\n');
    // Inert when the docroot is public/ (the normal case); saves us if it
    // isn't — see verifyDocroot below.
    await writeFile(join(stagingDir, '.htaccess'), 'Require all denied\n');

    await mkdir(WWW_DIR, { recursive: true });
    await renameWithRetry(stagingDir, projectDir);
    console.log(`${green(OK)} Project created at ${projectDir}`);

    // Park the resolved selections before anything can fail: `resume` reads
    // them so an interrupted run finishes with the choices already made,
    // rather than defaulting to "every available premium zip".
    await writeFile(
      join(projectDir, PENDING_SELECTION_FILE),
      `${JSON.stringify({ plugins: extraPlugins, premium: premiumSelection }, null, 2)}\n`,
      'utf8',
      // Non-fatal, but NOT silent: without this file a later bare `resume` falls
      // back to installing every available premium plugin, so the user needs to
      // know their choice is no longer recorded anywhere.
    ).catch((err) => {
      console.log(`  (could not record this run's plugin choices: ${err.message} — if you need to resume, pass --premium= explicitly)`);
    });

    if (instant) {
      console.log(`${cyan(STEP)} Instant mode: no Laragon reload needed.`);
      await ensureHostsEntryWithGuidance(hostname);
      if (!(await probeInstant(hostname, projectDir))) {
        bail(
          `${red(BAD)} The wildcard vhost did not serve ${hostname} within 12s — Apache may be down or the\n` +
            `  wildcard conf (${WILDCARD_CONF_PATH}) may have been removed.\n` +
            `  Run \`${CLI} doctor\`, fix what it reports, then:${resumeHint(name, extraPlugins, premiumSelection)}`,
        );
        return;
      }
      const httpsRes = sslCertPresent() ? await fetchViaLoopback(hostname, '/', { tls: true, timeoutMs: 2000 }) : null;
      const scheme = httpsRes ? 'https' : 'http';
      console.log(`${green(OK)} ${scheme}://${hostname} is live (served by the wildcard vhost)`);
      await finishInstall({ name, hostname, projectDir, extraPlugins, premiumSelection, scheme });
      return;
    }

    // Best-effort, exactly as in ensureHostsEntry: this is a BACKUP of a file
    // we are not the ones rewriting (Laragon's reload is), so an unreadable
    // hosts file or a full backups dir must not sink a scaffold whose project
    // folder is already in place.
    await snapshotHosts().catch((err) => {
      console.log(`  (could not back up the hosts file first: ${err.message} — continuing)`);
    });
    console.log(`${cyan(STEP)} Reloading Laragon (this can take a while, and may need you to approve a Windows permission prompt)…`);
    triggerReload();

    const pollResult = await pollForVhost(projectDir, hostname, {
      onTick: (msg) => console.log(`  … ${msg}`),
    });
    // The vhost conf's own `define SITE` is authoritative over our suffix
    // guess (see pollForVhost) — adopt it for everything downstream.
    if (pollResult.hostname) hostname = pollResult.hostname;

    if (!pollResult.ok && pollResult.reason === 'apache-down') {
      await reportApacheStillDown(name, hostname, extraPlugins, premiumSelection);
      return;
    }
    if (!pollResult.ok) {
      bail(
        `${red(BAD)} Timed out after ${Math.round(pollResult.elapsedMs / 1000)}s waiting for the vhost/hosts entry.\n` +
          `  vhost found: ${pollResult.vhost ? 'yes' : 'no'}  |  hosts entry: ${pollResult.hostsEntry ? 'yes' : 'no'}\n` +
          '  Open Laragon and click Reload yourself, then check http://' +
          hostname +
          ' once it settles.\n' +
          '  (A blank page is normal at this stage — WordPress is not installed yet.)' +
          resumeHint(name, extraPlugins, premiumSelection),
      );
      return;
    }

    console.log(`${green(OK)} Vhost + hosts entry ready after ${Math.round(pollResult.elapsedMs / 1000)}s`);
    await flushDnsCache(); // Laragon just wrote the hosts line — clear any cached negative lookups
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
        console.log(`${cyan(STEP)} Docroot points at the project root, not public\\ — repairing…`);
        await repairVhost(pollResult.vhost, projectDir);
      } else {
        console.log(`${cyan(STEP)} Vhost conf is on disk but not serving yet (outcome: ${outcome}) — reloading again…`);
      }
      triggerReload();
      const repoll = await pollForVhost(projectDir, hostname, { timeoutMs: 60_000 });
      if (!repoll.ok) {
        if (repoll.reason === 'apache-down') await reportApacheStillDown(name, hostname, extraPlugins, premiumSelection);
        else bail(`${red(BAD)} Retry reload did not complete (reason: ${repoll.reason}).${resumeHint(name, extraPlugins, premiumSelection)}`);
        return;
      }
      await sleep(3000);
      verify = await verifyDocroot(hostname, projectDir);
      if (!verify.ok) {
        const test = await testApacheConfig();
        bail(
          `${red(BAD)} Still not verifiable after a retry (outcome: ${verify.outcome}).${test.ok === false ? `\n  Config test failed:\n  ${test.output}` : ''}\n` +
            `  The vhost conf is correct on disk at ${pollResult.vhost.file}, but the running Apache\n` +
            '  process hasn\'t picked it up — confirmed live: `reload` alone doesn\'t reliably force a\n' +
            '  real restart once Apache has been up for a while. In Laragon, do a full Stop All then\n' +
            '  Start All (not just Reload), then check http://' +
            hostname +
            '.\n' +
            '  (A blank page is normal at this stage — WordPress is not installed yet.)' +
            resumeHint(name, extraPlugins, premiumSelection),
        );
        return;
      }
      console.log(`${green(OK)} Resolved after the retry reload.`);
    }

    console.log(`${green(OK)} http://${hostname} is live and serving from public\\`);
    await finishInstall({ name, hostname, projectDir, extraPlugins, premiumSelection });
  } catch (err) {
    bail(`${red(BAD)} Scaffold failed: ${err.message}`);
    await rmWithRetry(stagingDir).catch(() => {});
    if (await fileExists(projectDir)) {
      console.log(
        `  The partly-built site at ${projectDir} was left in place.\n` +
          `  To retry from where it stopped: ${resumeCommandLine(name, extraPlugins, premiumSelection)}\n` +
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
async function finishInstall({ name, hostname, projectDir, extraPlugins = [], premiumSelection, scheme = 'http' }) {
  if (!(await mysqlUp())) {
    throw new Error(`MySQL is not listening on :${MYSQL_PORT} — start it in Laragon, then retry.`);
  }
  const cred = await resolveRootCredential();
  if (!cred) {
    throw new Error('Could not resolve MySQL root credentials (tried empty and "root"). Set AGENTPRESS_MYSQL_ROOT_PASSWORD and retry.');
  }

  console.log(`${cyan(STEP)} Creating database…`);
  const db = await provisionDatabase(name, cred);
  console.log(`${green(OK)} Database ${db.dbName} + user ${db.dbUser} ready`);
  if (db.dbName !== sanitizeDbIdentifier(name, 64)) {
    console.log(`  (note: a previous attempt left a database named ${sanitizeDbIdentifier(name, 64)} — this run uses ${db.dbName}; the old one is unused and safe to drop by hand)`);
  }

  const adminUser = 'admin';
  const adminPassword = generatePassword('wp');
  const adminEmail = 'admin@example.com';

  const wp = await installWordPress({
    projectDir,
    hostname,
    scheme,
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
      `SITE_SCHEME=${scheme}`,
      `WP_ADMIN_USER=${adminUser}`,
      `WP_ADMIN_PASSWORD=${adminPassword}`,
      `WP_ADMIN_EMAIL=${adminEmail}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await protectProjectSecrets({ name, projectDir });

  await finishExtras({ name, hostname, projectDir, extraPlugins, premiumSelection, adminUser, adminPassword, adminEmail, siteUrl: `${scheme}://${hostname}`, scheme });
}

/**
 * The MCP half of a scaffold, extracted so `rewire` can re-run exactly this
 * against an existing site. Until v1.5.0 the ONLY way to (re)wire was a
 * scaffold or a resume, and resume refuses a completed site — so a site whose
 * machine-global wiring had been taken over by a newer scaffold had no way
 * back short of re-scaffolding or hand-editing an agent's config.
 *
 * Degrades, never aborts. MCP is an optional feature on a site that is
 * otherwise complete and serving, so a failed mint or a failed agent is
 * reported and the caller carries on. It also REPORTS failures rather than
 * letting them scroll past: previously a per-agent failure printed one line
 * mid-scaffold and then vanished, leaving the summary saying nothing at all
 * about the tool's headline feature.
 */
async function wireMcpForSite({ publicDir, hostname, adminUser, onStep = () => {} }) {
  onStep('detecting AI agent CLIs…');
  const detected = await detectAgents();
  const detectedKeys = Object.entries(detected)
    .filter(([, resolvedPath]) => resolvedPath)
    .map(([key]) => key);
  const configuredAgents = [];
  const failedAgents = [];
  if (!detectedKeys.length) return { detectedKeys, configuredAgents, failedAgents, verification: null };

  onStep('minting a WordPress application password for MCP…');
  let appPassword;
  try {
    appPassword = await mintAppPassword({ path: publicDir, adminUser, onStep: (m) => onStep(m) });
  } catch (err) {
    // Used to propagate and kill the whole scaffold — discarding the templates,
    // registry entry, admin login link and summary for an optional feature on a
    // working site.
    failedAgents.push({ key: 'all', reason: `could not mint the application password: ${err.message}` });
    return { detectedKeys, configuredAgents, failedAgents, verification: null };
  }
  // MCP deliberately stays on http: the proxy is a Node process whose trust
  // of Laragon's self-signed cert isn't guaranteed, and http always works.
  const creds = { wpApiUrl: `http://${hostname}/wp-json/mcp/mcp-adapter-default-server`, username: adminUser, password: appPassword };
  for (const key of detectedKeys) {
    onStep(`wiring MCP for ${key}…`);
    try {
      await MCP_CONFIGURERS[key](creds);
      configuredAgents.push(key);
    } catch (err) {
      failedAgents.push({ key, reason: err.message });
    }
  }

  // Prove it rather than assert it — one handshake against the endpoint with
  // the credential we just minted.
  let verification = null;
  if (configuredAgents.length) {
    onStep('checking the MCP endpoint answers…');
    verification = await verifyMcpEndpoint(creds);
    onStep(verification.ok ? `MCP endpoint answered (${verification.tools} tools)` : `⚠ the MCP endpoint did not answer: ${verification.detail}`);
    // A rejected credential is the one failure with a knowable cause, and the
    // probe that just failed used a password minted seconds ago — so "restart
    // your agent session" cannot be the explanation. Ask the site why.
    if (!verification.ok && /HTTP 40[13]/.test(verification.detail || '')) {
      verification.hints = await diagnoseAppPasswordAuth({ publicDir });
    }
  }
  return { detectedKeys, configuredAgents, failedAgents, verification };
}

/** The shared reporting for wireMcpForSite's outcome — identical for a scaffold and a rewire. */
function reportMcpOutcome({ detectedKeys, configuredAgents, failedAgents, verification }) {
  const lines = [];
  if (!detectedKeys.length) {
    lines.push(`${dim('·')} No AI agent CLI found on PATH, so no MCP wiring was written (everything else is set up).`);
    return lines;
  }
  if (configuredAgents.length) {
    const health = verification ? (verification.ok ? `verified, ${verification.tools} tools` : `NOT verified: ${verification.detail}`) : 'not checked';
    lines.push(`${verification && !verification.ok ? yellow(WARN) : green(OK)} MCP wired for: ${configuredAgents.join(', ')} (${health})`);
  }
  // The cause goes directly under the failure it explains, not in a footnote:
  // the whole problem with the old output was that the only actionable line on
  // screen ("restart your agent session") was the wrong one.
  //
  // Each hint carries its OWN fix. The first draft of this printed one shared
  // footer saying "repair with `update`", which is untrue for two of the three
  // causes — `update` touches neither wp-config.php nor a third-party plugin —
  // and would have reproduced the exact wrong-advice problem one layer down.
  for (const hint of verification?.hints || []) {
    lines.push(`  ${cyan(STEP)} ${hint}`);
  }
  for (const f of failedAgents) {
    lines.push(`${yellow(WARN)} MCP wiring ${f.key === 'all' ? 'failed' : `failed for ${f.key}`}: ${f.reason}`);
  }
  if (failedAgents.length) lines.push(`  Retry with:  ${CLI} rewire   (from this site's folder)`);
  return lines;
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
async function finishExtras({ name, hostname, projectDir, extraPlugins = [], premiumSelection, adminUser, adminPassword, adminEmail = 'admin@example.com', siteUrl, scheme = 'http' }) {
  const publicDir = join(projectDir, 'public');
  const onStep = (msg) => console.log(`  … ${msg}`);

  if (extraPlugins.length) {
    await installPlugins({ path: publicDir, plugins: extraPlugins, onStep });
  }

  // Always installed — Phase 7's MCP wiring depends on it, same as the
  // Docker original (which baked it into every scaffold regardless of the
  // user's own plugin selection).
  await installAgentConnector({ path: publicDir, onStep });

  // Re-asserted here, not only in installWordPress: this is the function that
  // installs the abilities pack, and it also runs for a `resume` whose
  // WordPress was installed by an OLDER version of this tool that never wrote
  // the guard. Idempotent, so the double-write on a fresh scaffold is free.
  await writeMcpLoopbackGuard(publicDir, { onStep });

  onStep('syncing premium plugins from GitHub…');
  await syncPremiumPluginsFromGitHub({ selection: premiumSelection, onStep });
  const premiumPlugins = await installPremiumPlugins({ path: publicDir, selection: premiumSelection, onStep });
  await applyLicenses({ path: publicDir, slugs: premiumPlugins, onStep });
  await updateAllPlugins({ path: publicDir, onStep });
  // AFTER the update, never before: that step pulls the vendor's current build
  // and would undo the patch. See plugins.mjs for what this is and why.
  await patchOxygenHtmlToPage({ path: publicDir, onStep });

  const mcp = await wireMcpForSite({ publicDir, hostname, adminUser, onStep });
  const { configuredAgents } = mcp;

  await copyTemplates(TEMPLATE_DIR, projectDir, {
    PROJECT_NAME: name,
    SITE_HOST: hostname,
    SITE_SCHEME: scheme,
    AGENTPRESS_VERSION: ENGINE_VERSION,
    WP_ADMIN_USER: adminUser,
    WP_ADMIN_EMAIL: adminEmail,
    WP_BAT_ESCAPED,
  });

  const sandboxConfigPath = join(projectDir, 'sandbox.config.json');
  const sandboxConfig = JSON.parse(await readFile(sandboxConfigPath, 'utf8'));
  if (extraPlugins.length) sandboxConfig.plugins = extraPlugins;
  if (premiumPlugins.length) sandboxConfig.premiumPlugins = premiumPlugins;
  sandboxConfig.agents = configuredAgents;
  // Set explicitly rather than trusting the template's own token: the template
  // shipped an unsubstituted __KATALYST_VERSION__ placeholder here (fixed, but
  // this also self-heals a site resumed with an old template on disk).
  sandboxConfig.scaffolderVersion = ENGINE_VERSION;
  await writeFile(sandboxConfigPath, `${JSON.stringify(sandboxConfig, null, 2)}\n`, 'utf8');

  // The site is complete — the parked selections have served their purpose,
  // and leaving the file behind would misreport a finished site as interrupted.
  await rm(join(projectDir, PENDING_SELECTION_FILE), { force: true }).catch(() => {});

  await recordEnvironment({
    name,
    dir: projectDir,
    hostname,
    port: null,
    agents: configuredAgents,
    createdAt: new Date().toISOString(),
  });

  const adminUrl = await mintAdminLoginUrl({ path: publicDir, hostname, scheme });

  console.log(
    `\n${green(OK)} WordPress is ready.\n` +
      // Always say something about MCP — the headline feature used to be simply
      // absent from this panel whenever nothing was wired, whether that was
      // because no agent CLI exists or because every one of them failed.
      `${reportMcpOutcome(mcp).map((l) => `${l}\n`).join('')}` +
      `  Site   ${siteUrl}\n` +
      `  Admin  ${adminUrl}\n` +
      `  User   ${adminUser}\n` +
      `  Pass   ${adminPassword}\n\n` +
      `  cd ${projectDir}\n` +
      '  npm run agentpress   # open the menu\n' +
      // Only when something is actually wired: /verify tests the MCP path, so
      // suggesting it with no agent configured would send the user at a check
      // that cannot pass. This is the one moment they are looking at the
      // output, so it is where the feature has to be mentioned — the README is
      // not where anyone looks after a successful scaffold.
      (mcp.configuredAgents?.length
        ? `\n  Then open this folder in ${AGENT_LABELS[mcp.configuredAgents[0]] || 'your agent'} and run ${cyan('/verify')} —\n` +
          '  it exercises both MCP servers and Oxygen end to end, and builds the site a\n' +
          '  holding page recording what passed.\n'
        : ''),
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
  // Resolved before the plugin flags below, because readPendingSelection needs
  // the project directory to find the interrupted scaffold's parked choices.
  const projectDir = join(WWW_DIR, name);
  if (!(await fileExists(projectDir))) {
    bail(`${red(BAD)} No folder at ${projectDir} — nothing to resume. Use the normal scaffold command instead.`);
    return;
  }
  // An explicit flag always wins; otherwise inherit what the interrupted
  // scaffold had already resolved, so resuming can't quietly install premium
  // plugins the user declined (an absent file falls back to the old default of
  // every available zip, which is right for a site scaffolded before this).
  const pending = await readPendingSelection(projectDir);
  const extraPlugins =
    typeof flags.plugins === 'string'
      ? flags.plugins
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : pending.plugins || [];
  const hasEnv = await fileExists(join(projectDir, '.env'));
  const hasSandbox = await fileExists(join(projectDir, 'sandbox.config.json'));
  if (hasEnv && hasSandbox) {
    console.log(`"${name}" is fully set up — nothing to resume. (Use \`update\` from its directory to refresh tooling files.)`);
    return;
  }

  const state = await preflight();
  if (!state.laragonInstalled) {
    bail(
      `${red(BAD)} No laragon.exe found under the resolved Laragon root. If Laragon is installed somewhere\n` +
        '  unusual, set AGENTPRESS_LARAGON_ROOT to its folder (e.g. D:\\laragon) and retry.',
    );
    return;
  }
  if (!state.laragonRunning) {
    bail(`${red(BAD)} Laragon is not running. Start it and try again.`);
    return;
  }
  if (state.webServer === 'nginx') {
    bail(`${red(BAD)} Laragon is in Nginx mode — this tool currently supports Apache only. Switch to Apache in Laragon, then retry.`);
    return;
  }
  if (state.webServer === 'foreign') {
    bail(`${red(BAD)} Something other than Laragon's Apache is listening on port 80 (IIS?). Stop it or move it off :80, then retry.`);
    return;
  }
  if (!state.apacheUp) {
    bail(`${red(BAD)} Apache is not listening on :80. Start it in Laragon (Start All) and try again.`);
    return;
  }

  const instant = wildcardConfInstalled() && (await wildcardActive());
  const vhost = await findVhostForProject(projectDir);
  if (!vhost && !instant) {
    // The folder exists (checked above) but Laragon hasn't generated its
    // vhost — an interrupted scaffold killed before the reload finished.
    // Pointing back at the scaffold command would just loop (it collides on
    // the folder and points here); the actual fix is a Laragon reload,
    // which generates vhosts for existing www\ folders.
    bail(
      `${red(BAD)} No vhost exists yet for ${projectDir}.\n` +
        '  Open Laragon and click Reload (it generates vhosts for folders in www\\), wait for it\n' +
        '  to settle, then retry this same resume command.',
    );
    return;
  }
  const { suffix } = await inferHostnameSuffix();
  const env = hasEnv ? parseEnvFile(await readFile(join(projectDir, '.env'), 'utf8')) : {};
  const hostname = env.SITE_HOST || vhost?.hostname || `${name}${suffix}`;
  if (!(await hostsHasEntry(hostname))) {
    if (instant) {
      await ensureHostsEntryWithGuidance(hostname);
    } else {
      bail(`${red(BAD)} No hosts entry for ${hostname} yet. Open Laragon and click Reload, wait for it to settle, then retry resume.`);
      return;
    }
  }

  console.log(`${cyan(STEP)} Checking the site is reachable…`);
  if (instant) {
    if (!(await probeInstant(hostname, projectDir))) {
      bail(`${red(BAD)} The wildcard vhost did not serve ${hostname} — run \`${CLI} doctor\`, fix what it reports, then retry resume.`);
      return;
    }
  } else {
    const verify = await verifyDocroot(hostname, projectDir);
    if (!verify.ok) {
      const test = await testApacheConfig();
      bail(
        `${red(BAD)} Not reachable yet (outcome: ${verify.outcome}).${test.ok === false ? `\n  Config test failed:\n  ${test.output}` : ''}\n` +
          '  In Laragon, do a full Stop All then Start All, then retry resume.',
      );
      return;
    }
  }
  console.log(`${green(OK)} http://${hostname} is live and serving from public\\`);

  const scheme = env.SITE_SCHEME || (sslCertPresent() && (await fetchViaLoopback(hostname, '/', { tls: true, timeoutMs: 2000 })) ? 'https' : 'http');

  // Resume finishes the job without a picker: an explicit --premium wins, else
  // the interrupted scaffold's own parked answer, else (nothing parked) every
  // available zip, same as a --yes scaffold. An empty parked selection must
  // resolve to the literal 'none' — `[].join(',')` is '', which would read as
  // "no flag given" and silently install everything.
  const parkedPremium = pending.premium ? pending.premium.join(',') || 'none' : undefined;
  const premiumSelection = await choosePremiumPlugins({
    flagValue: typeof flags.premium === 'string' ? flags.premium : parkedPremium,
    yes: true,
  });
  if (parkedPremium !== undefined && typeof flags.premium !== 'string') {
    console.log(
      `  (premium plugins: reusing this scaffold's original choice — ${premiumSelection.length ? premiumSelection.join(', ') : 'none'}; override with --premium=)`,
    );
  }

  const release = await acquireScaffoldLock();
  try {
    if (hasEnv) {
      console.log(`${cyan(STEP)} WordPress is already installed — finishing plugins, MCP wiring, and tooling…`);
      await finishExtras({
        name,
        hostname,
        projectDir,
        extraPlugins,
        premiumSelection,
        adminUser: env.WP_ADMIN_USER || 'admin',
        adminPassword: env.WP_ADMIN_PASSWORD || '(see .env)',
        adminEmail: env.WP_ADMIN_EMAIL || 'admin@example.com',
        siteUrl: `${scheme}://${hostname}`,
        scheme,
      });
    } else {
      await finishInstall({ name, hostname, projectDir, extraPlugins, premiumSelection, scheme });
    }
  } catch (err) {
    // Echo the resolved selections, same as the scaffold's own hints: a bare
    // retry line here would re-introduce exactly the bug this release fixes,
    // since a resume that already narrowed --premium would widen again on the
    // next attempt (and the parked file is gone once extras have completed).
    bail(`${red(BAD)} Resume failed: ${err.message}\n  Safe to retry: ${resumeCommandLine(name, extraPlugins, premiumSelection)}`);
  } finally {
    await release();
  }
}

async function listCommand() {
  console.log(formatEnvironmentsTable(await listEnvironments()));
}

/**
 * Split on either line ending. We write LF, but an editor that normalises to
 * CRLF (a Notepad "save") used to make EVERY line fail this match — `.` never
 * matches `\r` and `$` isn't in multiline mode — silently yielding an empty
 * env. That was not a cosmetic bug: destroy then saw no DB_NAME and skipped
 * dropping the database, and resume lost SITE_HOST.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Refreshes only AgentPress-owned files (scripts/, wp-cli.yml, README,
 * .gitignore, package.json's known scripts) — never .env, sandbox.config.json,
 * or the user's own content. Ported policy from the Docker original; the
 * skip-set + package.json merge model is backend-agnostic.
 *
 * ONE deliberate exception under public/: the agent-API loopback guard (the
 * mu-plugin and our marked `.htaccess` block, both written by
 * writeMcpLoopbackGuard). Those are files AgentPress owns outright, and this is
 * the only backfill route for sites scaffolded before the guard existed — up to
 * v1.2.0 the containment was a single .htaccess rule that was bypassable, so
 * "update never touches public/" would have left every existing site exposed
 * with no way to fix it short of re-scaffolding. Nothing else under public/ is
 * read or written.
 */
/**
 * Re-points the machine-global MCP wiring at THIS site, from inside its folder.
 *
 * The wiring is machine-global by design (one `wordpress` entry per agent CLI,
 * newest scaffold wins — documented in README). What was missing was any way
 * back: `resume` refuses a completed site, `update` never touched MCP, and the
 * site menu happily launched an agent whose `wordpress` server pointed at a
 * different site. So the documented trade-off had no recovery path, and this is
 * it. Also the only way to wire an agent CLI installed AFTER the site was made.
 *
 * Re-mints the application password, which invalidates the previous one — that
 * is deliberate: the plaintext only exists at creation time, so there is
 * nothing to reuse.
 */
async function rewireCommand() {
  const cwd = process.cwd();
  let env;
  try {
    env = parseEnvFile(await readFile(join(cwd, '.env'), 'utf8'));
  } catch {
    bail(`${red(BAD)} No .env here — run rewire from inside a scaffolded site's directory.`);
    return;
  }
  // Same gate `update` and `destroy` enforce. Without it, rewire would run in
  // any folder holding a .env and a public\ — minting a credential and pointing
  // every agent CLI at whatever that folder's SITE_HOST claimed. It failed
  // safely (wp-cli refuses a non-WordPress path) but only after printing a
  // confusing "check wp-admin" warning about a site that does not exist.
  if (!(await isAgentPressSiteDir(cwd))) {
    bail(
      `${red(BAD)} This folder has a .env but no sandbox.config.json or scripts\\agentpress.mjs — it does\n` +
        '  not look like a site this tool created, so rewire will not touch it.\n' +
        `  (Currently in: ${cwd})`,
    );
    return;
  }
  if (!(await fileExists(join(cwd, 'public')))) {
    bail(`${red(BAD)} No public\\ folder here — this does not look like a scaffolded site.`);
    return;
  }
  const hostname = env.SITE_HOST;
  if (!hostname) {
    bail(`${red(BAD)} This site's .env has no SITE_HOST, so there is no endpoint to point agents at.`);
    return;
  }
  // .env is not trusted input here — it can be hand-edited or arrive copied
  // from someone else's project, and this value is interpolated into a URL that
  // gets written into every agent's config. Validate, don't sanitise (the same
  // stance the frozen site menu and ensureHostsEntry already take).
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(hostname)) {
    bail(`${red(BAD)} Refusing to use SITE_HOST "${hostname}" from .env — that is not a valid hostname.`);
    return;
  }

  // Say what is being taken over BEFORE doing it — the silent steal is the
  // whole complaint this command exists to answer.
  const before = await readWiredHostnames();
  const displaced = [...new Set(Object.values(before).filter((h) => h && h !== hostname.toLowerCase()))];
  if (displaced.length) {
    console.log(`${cyan(STEP)} Re-pointing MCP away from ${displaced.join(', ')} and at ${hostname}.`);
  }

  const adminUser = env.WP_ADMIN_USER || 'admin';
  const publicDir = join(cwd, 'public');
  // Repair BEFORE minting, not after diagnosing. A site whose .htaccess has
  // lost the Authorization passthrough cannot authenticate any credential this
  // command creates, so wiring first would guarantee the 401 it then has to
  // explain — which is the loop a user hit in the field, re-running rewire and
  // restarting their agent against a site that could never have answered.
  // Idempotent and near-free on a healthy site.
  const repair = await ensureHtaccessGuardBlock(publicDir);
  if (repair.restoredAuth) {
    console.log(
      `${cyan(STEP)} Restored the Application Password passthrough in public/.htaccess —\n` +
        '  without it Apache strips the credential and every application password 401s.',
    );
  }
  const result = await wireMcpForSite({
    publicDir,
    hostname,
    adminUser,
    onStep: (m) => console.log(`  … ${m}`),
  });
  console.log('');
  for (const line of reportMcpOutcome(result)) console.log(line);
  // Rewire mints a NEW application password, which invalidates the old one. An
  // agent session that was already open still holds the previous credential in
  // its running MCP server process and will keep answering 401 — while this
  // command has just printed "verified". Confirmed live: the new credential
  // authenticates fine over HTTP at the same moment the open session 401s.
  // Without this line the user is told it worked and then watches it not work.
  // Only when the endpoint actually answered. Printing this after a FAILED
  // verification was the original sin of this output: it is the correct advice
  // for exactly one cause (a session holding the pre-rewire password) and it
  // was shown for all of them, so a user whose site could not authenticate at
  // all was told to keep restarting their agent. On failure the hints above
  // have already said what is really wrong.
  if (result.configuredAgents?.length && result.verification?.ok !== false) {
    console.log(
      `${cyan(STEP)} If an agent session is already open, restart it (or reconnect its MCP\n` +
        '  servers) — it is still holding the previous application password.\n' +
        `  Then run ${cyan('/verify')} in the agent to confirm the wiring end to end.`,
    );
  }

  // ONLY record when something actually landed. Writing the empty result was a
  // real bug: on every failure path (mint failed, no agent CLI on PATH, every
  // configurer threw) nothing had been changed on the agent side, yet the
  // site's own record was wiped — and that record is load-bearing. The frozen
  // menu builds its agent list from it, and `destroy` decides which MCP entries
  // to remove from it, so an empty list silently disarms teardown and leaves a
  // machine-global entry pointing at a deleted site.
  if (!result.configuredAgents.length) {
    console.log(`  ${dim("This site's recorded agents were left unchanged.")}`);
    process.exitCode = 1;
    return;
  }
  const sandboxPath = join(cwd, 'sandbox.config.json');
  try {
    const cfg = JSON.parse(await readFile(sandboxPath, 'utf8'));
    // Union, not replace: rewiring claude must not un-record cursor, which is
    // still wired and which destroy still needs to clean up.
    cfg.agents = [...new Set([...(Array.isArray(cfg.agents) ? cfg.agents : []), ...result.configuredAgents])];
    await writeFile(sandboxPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  } catch {
    // no sandbox.config.json (a very old site) — the wiring still landed
  }
  await recordEnvironment({ dir: cwd, agents: result.configuredAgents, updatedAt: new Date().toISOString() });
}

async function updateProject({ yes }) {
  const cwd = process.cwd();
  let envContent;
  try {
    envContent = await readFile(join(cwd, '.env'), 'utf8');
  } catch {
    bail(`${red(BAD)} No .env here — run update from a agentpress site directory.`);
    return;
  }
  // A bare .env is far too common to be the only gate — `update --yes` in
  // any random Node project with a .env used to gut its package.json and
  // overwrite README/.gitignore. Require an actual katalyst marker.
  if (!(await isAgentPressSiteDir(cwd))) {
    bail(
      `${red(BAD)} This folder has a .env but no sandbox.config.json or scripts\\katalyst.mjs — it does not\n` +
        '  look like a agentpress site, so update will not touch it.',
    );
    return;
  }
  const env = parseEnvFile(envContent);
  const vars = {
    PROJECT_NAME: basename(cwd),
    SITE_HOST: env.SITE_HOST || 'localhost',
    SITE_SCHEME: env.SITE_SCHEME || 'http',
    AGENTPRESS_VERSION: ENGINE_VERSION,
    WP_ADMIN_USER: env.WP_ADMIN_USER || 'admin',
    WP_ADMIN_EMAIL: env.WP_ADMIN_EMAIL || 'admin@example.com',
    WP_BAT_ESCAPED,
  };

  console.log(
    "This refreshes scripts/, wp-cli.yml, .gitignore, README.md, package.json's known\n" +
      'scripts, and the MCP loopback guard mu-plugin. Your .env, sandbox.config.json, and any\n' +
      'custom package.json scripts are preserved. If you hand-edited any refreshed file, those\n' +
      'edits will be overwritten — take a backup first (a git commit, or a copy of the folder).',
  );
  if (!yes) {
    if (!process.stdin.isTTY) {
      bail(`${red(BAD)} Not updating: confirm with --yes when running non-interactively.`);
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
  // The one deliberate exception to "update never touches public/": this is a
  // file AgentPress owns outright, and it is the backfill path for sites
  // scaffolded before the guard existed (up to v1.2.0, where the .htaccess
  // rewrite was the only containment layer and was bypassable). Skipped for a
  // site with no public/ rather than creating a stray tree.
  if (await fileExists(join(cwd, 'public'))) {
    const wrote = await writeMcpLoopbackGuard(join(cwd, 'public'), { onStep: (msg) => console.log(`  ${msg}`) });
    if (wrote) console.log('  … MCP loopback guard in place');
    // A SECOND exception, and unlike the guard above this one edits a file
    // AgentPress does not own — see plugins.mjs for the justification. Backfill
    // matters here for the same reason it did for the guard: without it, every
    // site scaffolded before this shipped keeps a builder tool that fails on
    // every input, with no route to a fix short of re-scaffolding.
    await patchOxygenHtmlToPage({ path: join(cwd, 'public'), onStep: (msg) => console.log(`  ${msg}`) });
  }
  await recordEnvironment({ dir: cwd, updatedAt: new Date().toISOString() });
  console.log(`${green(OK)} Updated to v${ENGINE_VERSION}.`);
}

/**
 * Run from within a site directory (like `update`). Order matters — see
 * destroy.mjs's own header for why MCP/app-password cleanup must happen
 * before the database is dropped, and the database before the vhost/folder.
 */
async function destroyCommand({ yes }) {
  const cwd = process.cwd();
  if (!(await fileExists(join(cwd, '.env')))) {
    bail(`${red(BAD)} No .env here — run destroy from a agentpress site directory.`);
    return;
  }
  // A bare .env is nowhere near enough to authorize an rm -rf: a typical
  // www\ holds dozens of unrelated projects that have one (36 on the
  // author's machine). `update` already learned this and requires a real
  // marker; destroy — which deletes the whole directory and drops a
  // database — must be at least as strict. Both checks are enforced even
  // under --yes, because this tool is routinely driven by agent CLIs that
  // pass --yes by default.
  if (!(await isAgentPressSiteDir(cwd))) {
    bail(
      `${red(BAD)} This folder has a .env but no sandbox.config.json or scripts\\agentpress.mjs — it does\n` +
        '  not look like a site this tool created, so destroy will not touch it.\n' +
        `  (Currently in: ${cwd})`,
    );
    return;
  }
  // Containment: only ever delete a direct child of Laragon's www — never a
  // drive root, a home directory, or something reached via an odd cwd.
  const parent = resolve(cwd, '..');
  if (resolve(cwd) === resolve(WWW_DIR) || parent.toLowerCase() !== resolve(WWW_DIR).toLowerCase()) {
    bail(
      `${red(BAD)} Refusing to destroy ${cwd} — destroy only removes a site directly inside ${WWW_DIR}.\n` +
        '  cd into the site folder itself and try again.',
    );
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
      bail(`${red(BAD)} Not destroying: confirm with --yes when running non-interactively.`);
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
    `\n${green(OK)} Destroyed.${result.removedAgents.length ? ` MCP entries removed for: ${result.removedAgents.join(', ')}.` : ''}` +
      `${result.dbDropped ? ' Database dropped.' : ` (database not dropped: ${result.dbSkipReason})`}\n` +
      // The preamble above promises this credential is removed, so a failure to
      // revoke belongs in the SUMMARY, not only in a step line that scrolled
      // past mid-teardown. It is an admin-equivalent REST credential and the
      // site is about to stop existing, so it cannot be revoked later.
      (result.appPasswordRevoked === null
        ? `\n${yellow(WARN)} The application password could NOT be confirmed revoked. It still grants REST admin.\n` +
          '  Remove it by hand in wp-admin ▸ Users ▸ Profile ▸ Application Passwords before the site goes.\n'
        : '') +
      (result.hostname ? `\nRemaining trace: a hosts entry for ${result.hostname} — safe to leave, or remove by hand.\n` : ''),
  );
  if (!result.dbDropped && result.dbSkipReason !== 'no database recorded in .env') process.exitCode = 1;
  if (result.appPasswordRevoked === null) process.exitCode = 1;
}

/**
 * Does this directory actually look like a site WE made? A bare `.env` is
 * nowhere near enough — a typical Laragon www\ holds dozens of unrelated
 * projects with one. Every command that acts on "the site I am standing in"
 * must agree on this, so it lives in one place: `update` (which overwrites
 * tooling files), `destroy` (which deletes a tree and drops a database) and
 * `rewire` (which mints a credential and takes machine-global state).
 */
async function isAgentPressSiteDir(cwd) {
  return (
    (await fileExists(join(cwd, 'sandbox.config.json'))) ||
    (await fileExists(join(cwd, 'scripts', 'agentpress.mjs'))) ||
    (await fileExists(join(cwd, 'scripts', 'katalyst.mjs'))) // pre-rename sites
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

function printAvailabilityTable(availability) {
  console.log('\nPremium plugins on this machine:');
  for (const p of availability) {
    console.log(`  ${p.available ? green(OK) : red(BAD)} ${p.label.padEnd(52)} ${p.available ? basename(p.zip) : 'no zip yet'}`);
  }
}

/**
 * The machine-setup assistant half of setup: gets the premium plugin ZIPS
 * into place (with hand-holding — open the folder, re-scan after dropping
 * files in) and captures the license key. It deliberately does NOT ask
 * which plugins to install: that choice is per-PROJECT and happens at
 * scaffold time (a shop needs WooCommerce, a brochure site doesn't).
 * TTY-only — non-interactive runs change nothing.
 */
async function setupPreferences() {
  if (!process.stdin.isTTY) return;
  const config = await loadConfig();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let availability = await premiumPluginAvailability();
    printAvailabilityTable(availability);
    const missing = availability.filter((p) => !p.available);
    if (missing.length) {
      const dir = join(AGENTPRESS_HOME, 'premium-plugins');
      console.log(`\n  To make a plugin available, drop your licensed zip into:\n    ${dir}`);
      console.log(`  Expected filenames: ${missing.map((p) => `${p.slug}[-*].zip`).join(', ')}`);
      console.log('  (Or keep them in your own private GitHub releases repo — premiumPluginsRepo in config.json, see the README.)');
      const open = (await rl.question('  Open that folder in Explorer now so you can drop zips in? [y/N]: ')).trim();
      if (/^y(es)?$/i.test(open)) {
        const { spawn } = await import('node:child_process');
        await mkdir(dir, { recursive: true });
        // Absolute path: bare 'explorer' would let an explorer.exe in the CWD win
        // (Windows CreateProcess searches the current directory).
        // 'C:\\Windows' — `\W` is not a JS escape, so the single-backslash form
        // silently collapsed to the relative path "C:Windows".
        spawn(join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir], { detached: true, stdio: 'ignore' }).unref();
        await rl.question('  Press Enter when you have added your zips (or Enter to continue without)… ');
        availability = await premiumPluginAvailability();
        printAvailabilityTable(availability);
      }
    }

    const existing = config.licenses?.oxygen || null;
    const hint = existing ? `Enter keeps the saved key (${existing.slice(0, 4)}…)` : 'Enter to skip — you can activate in wp-admin instead';
    const answer = (await rl.question(`\n  Oxygen license key (one key covers all the extensions; ${hint}): `)).trim();
    if (answer) {
      config.licenses = { ...(config.licenses || {}), oxygen: answer };
      if (!/^[a-f0-9]{32}$/i.test(answer)) {
        console.log('  (saved — note it does not look like the usual 32-character key, double-check if activation fails)');
      }
    }

    // Per-project selection made this obsolete — a stale machine-wide list
    // would silently filter the scaffold-time picker.
    delete config.premiumPlugins;
    await saveConfig(config);
    const availableCount = availability.filter((p) => p.available).length;
    console.log(
      `${green(OK)} Saved. ${availableCount}/${availability.length} premium plugins available${config.licenses?.oxygen ? ', Oxygen license on file' : ''}.` +
        ' You will pick which ones each project gets when you scaffold it.',
    );
  } finally {
    rl.close();
  }
}

/**
 * One-time instant-mode enablement: writes the wildcard vhost conf, then
 * either confirms it's live (Apache restarted since) or tells the user to
 * do the single Stop All → Start All this will ever need. Safe to re-run
 * any time — it's how you verify after the restart, too. Also runs the
 * preferences wizard (premium plugins + license key).
 */
async function setupCommand() {
  // No banner here — create() prints it for every command; a second call
  // would double it on setup specifically.
  const state = await preflight();
  if (state.webServer === 'nginx') {
    bail(`${red(BAD)} Laragon is in Nginx mode — instant mode is Apache-only. Switch to Apache first.`);
    return;
  }

  await setupPreferences();

  const { suffix, updated } = await installWildcardConf();
  if (updated) {
    console.log(`${green(OK)} Wildcard vhost written to ${WILDCARD_CONF_PATH} (serves *${suffix} from www\\<name>\\public${sslCertPresent() ? ', http + https' : ''})`);
  } else {
    console.log(`${green(OK)} Wildcard vhost already current at ${WILDCARD_CONF_PATH}`);
  }
  if (!sslCertPresent()) {
    console.log("  (no Laragon SSL cert found — https will light up if you enable SSL in Laragon's menu and re-run setup)");
  }
  if (!state.apacheUp) {
    console.log(
      `${cyan(STEP)} Apache is not running — click Start All in Laragon, then run setup again to verify.\n` +
        `\n  All commands: ${CLI} help`,
    );
    return;
  }
  console.log(`${cyan(STEP)} Verifying it is live (serving a probe through the wildcard)…`);
  const httpLive = await wildcardActive();
  const httpsLive = sslCertPresent() && (await wildcardActive({ tls: true }));
  if (httpLive && (httpsLive || !sslCertPresent())) {
    console.log(
      `\n${green(OK)} Instant mode is ACTIVE${httpsLive ? ' (http + https)' : ''}. Scaffolds no longer trigger Laragon reloads —\n` +
        '  no machine-wide blips, no reload-staleness failures, sites are live instantly.\n' +
        (httpsLive
          ? "  (https uses Laragon's own certificate — if the browser warns about trust, enable\n   SSL once in Laragon's menu, which registers the cert with Windows.)\n"
          : '') +
        '\n  Setup is done — you never need to run it again on this machine (unless you\n' +
        '  want to add plugin zips or change the license key).\n' +
        `\n  Next: create your first site with  ${CLI} my-site\n` +
        `  All commands: ${CLI} help`,
    );
    return;
  }
  if (httpLive && !httpsLive) {
    console.log(
      `\n${cyan(STEP)} http is live, but the https half of the wildcard needs the running Apache to\n` +
        '  reload the updated conf. ONE-TIME step: in Laragon, do a full Stop All →\n' +
        `  Start All, then run \`${CLI} setup\` again to confirm.\n` +
        `\n  All commands: ${CLI} help`,
    );
    return;
  }
  console.log(
    `\n${cyan(STEP)} Not active yet — the running Apache predates the conf. ONE-TIME step:\n` +
      '  in Laragon, do a full Stop All → Start All (not just Reload), then run\n' +
      `  \`${CLI} setup\` again to confirm. After that, no scaffold ever needs a reload.\n` +
      `\n  All commands: ${CLI} help`,
  );
}

async function registerQuickAppCommand() {
  const result = await registerQuickApp();
  if (!result.added) {
    console.log(`Not added: ${result.reason}.`);
    return;
  }
  console.log(
    `${green(OK)} Added a "AgentPress" entry to sites.conf (backed up to ${result.backup}).\n` +
      'Reopen Laragon\'s tray menu (Quick app) to see it. Note: Quick app\'s own AutoCreateDatabase\n' +
      "will also create a plain DB named after the project — this tool's own DB (a differently-\n" +
      'named, dedicated user) is what the site actually uses; the Quick-app-created one is unused\n' +
      'and safe to drop by hand.',
  );
}

function printUsage() {
  console.log(`
create-agentpress v${ENGINE_VERSION} — local WordPress + AI-agent dev environments on Laragon

  ${CLI} doctor              Check this machine's Laragon/PHP/MySQL/Node state
  ${CLI} setup               One-time: enable instant scaffolds (no Laragon reloads)
  ${CLI} <name>              Scaffold a WordPress site at http://<name>.test (or your Laragon suffix)
  ${CLI} resume <name>       Finish an interrupted scaffold
  ${CLI} list                List scaffolded sites
  ${CLI} register-quick-app  Add a Laragon Quick app entry for this tool

From inside a scaffolded site's directory:

  ${CLI} update      Refresh AgentPress's own tooling files
  ${CLI} rewire      Point the AI agents' MCP connection back at THIS site
  ${CLI} destroy     Permanently remove that site

Flags: --yes/-y  --help/-h  --version/-v  --plugins=slug1,slug2 (wordpress.org)  --premium=all|none|slug1,slug2
Env:   AGENTPRESS_LARAGON_ROOT  AGENTPRESS_MYSQL_ROOT_PASSWORD  AGENTPRESS_MYSQL_PORT  AGENTPRESS_PREMIUM_PLUGINS_REPO
       AGENTPRESS_NO_BANNER (hide the wordmark)  NO_COLOR / FORCE_COLOR (colour off / on)
`);
}

const KNOWN_FLAGS = new Set(['plugins', 'premium']);
const KNOWN_COMMANDS = new Set(['doctor', 'setup', 'list', 'resume', 'update', 'rewire', 'destroy', 'register-quick-app', 'help', 'version']);

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

  // One brand header for EVERY command, emitted here at the single dispatch
  // point rather than per-command so it cannot drift as commands are added.
  // (Earlier revision put it in setupCommand only, on the reasoning that
  // doctor gets re-run while something is already broken; overruled — the
  // header is wanted everywhere.) Excluded: `--version`/`version`, whose bare
  // `create-agentpress vX.Y.Z` line is the machine-readable one people script
  // against. Suppressed automatically for non-TTY/NO_COLOR, and by
  // AGENTPRESS_NO_BANNER.
  if (!args.version && args.command !== 'version') {
    process.stdout.write(banner(`v${ENGINE_VERSION} · AI-agent-ready WordPress`));
  }

  for (const flag of Object.keys(args.flags)) {
    if (!KNOWN_FLAGS.has(flag)) {
      const hint = flag === 'plugin' ? ' (did you mean --plugins?)' : '';
      console.log(`${yellow(WARN)} Unknown flag --${flag}${hint} — ignoring it.`);
    }
  }

  if (args.version) {
    console.log(`create-agentpress v${ENGINE_VERSION}`);
    return;
  }

  if (args.help || args.command === 'help') {
    printUsage();
    return;
  }

  if (args.command === 'version') {
    console.log(`create-agentpress v${ENGINE_VERSION}`);
    return;
  }

  if (args.command === 'doctor') {
    await runDoctor({ cli: CLI });
    return;
  }

  if (args.command === 'setup') {
    await setupCommand();
    return;
  }

  if (args.command === 'list') {
    await listCommand();
    return;
  }

  if (args.command === 'resume') {
    const name = args.positional[1];
    if (!name) {
      bail(`${red(BAD)} Usage: ${CLI} resume <name>`);
      return;
    }
    await resumeCommand(name, { flags: args.flags });
    return;
  }

  if (args.command === 'update') {
    await updateProject({ yes: args.yes });
    return;
  }

  if (args.command === 'rewire') {
    await rewireCommand();
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
      console.log(`${yellow(WARN)} "${args.command}" looks like a mistyped command (did you mean "${close}"?) — treating it as a SITE NAME to scaffold.`);
    }
    await scaffoldSite(args.command, { flags: args.flags, yes: args.yes });
    return;
  }

  printUsage();
}
