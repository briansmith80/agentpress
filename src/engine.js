import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { banner, bold, cyan, dim, green, pink, red, yellow, BAD, INFO, OK, STEP, WARN } from './ansi.mjs';
import { runDoctor } from './doctor.mjs';
import { AGENTPRESS_HOME, HOSTS_PATH, LARAGON_ROOT, REGISTRY_PATH, SCAFFOLD_LOCK_PATH, WWW_DIR } from './paths.mjs';
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
import { compareVersionsDesc } from './wp.mjs';
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
import { certCoversHostname, ensureHostsEntry, fetchViaLoopback, flushDnsCache, installWildcardConf, sslCertPresent, wildcardActive, wildcardConfInstalled, WILDCARD_CONF_PATH } from './wildcard.mjs';
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
  // No `verbose` field. `--verbose` was parsed into one, never read anywhere, and
  // absent from `help` — and because it was a named field it was structurally
  // exempt from the unknown-flag warning, so the tool silently accepted a flag
  // that did nothing. Dropped, so it now falls into `flags` and warns like any
  // other unrecognised flag.
  const out = { command: null, positional: [], flags: {}, stray: [], yes: false, help: false, version: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') {
      out.yes = true;
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
    // A single-dash token that is not one of the four handled above used to
    // fall off the end of this loop and vanish without a word — `-premium=none`
    // (one dash) was accepted in silence and ignored. Collected so the caller
    // can say so; deliberately NOT treated as a positional, because that would
    // turn a typo into a site name.
    if (a.startsWith('-')) {
      out.stray.push(a);
      continue;
    }
    out.positional.push(a);
    if (out.command === null) out.command = a;
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
        console.log(`  ${dim(`(removing stale scaffold lock from pid ${lock.pid ?? '?'}, started ${lock.startedAt ?? 'unknown'})`)}`);
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
  return `\n  When the site responds again, finish the install with: ${pink(resumeCommandLine(name, extraPlugins, premiumSelection))}`;
}

/**
 * The scaffold's resolved selections, parked in the project directory so an
 * interrupted run can be finished with the SAME choices. Deleted once the
 * site is complete, so its presence also marks "this scaffold never finished".
 */
const PENDING_SELECTION_FILE = '.agentpress-pending.json';
/**
 * Written into the staging `public/index.php` and read back by
 * `agentPressMarkers` as the earliest proof a folder is ours. One constant, not
 * two literals: the writer and the reader are ~400 lines apart, and a silent
 * drift between them would make `resume` refuse a genuinely interrupted scaffold.
 */
const STAGING_INDEX_MARKER = 'agentpress placeholder';

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
async function choosePremiumPlugins({ flagValue, yes, prompts = null }) {
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

  // Say what the silent default resolved to. Non-interactively an unset
  // --premium means "install everything available", which is a defensible
  // default but was announced nowhere: the only evidence was the per-plugin
  // install lines much later. Every remaining route to the wrong plugin set
  // (a misspelled flag name, an omitted flag, a piped stdin) lands here, so
  // this one line is where the surprise stops being silent.
  if (yes || !process.stdin.isTTY) {
    if (available.length) {
      console.log(
        `  ${dim('·')} no --premium given, so installing all ${available.length} premium plugin${available.length === 1 ? '' : 's'} available on this machine` +
          ` (${available.map((p) => p.slug).join(', ')}). Use --premium=none to skip them.`,
      );
    }
    return available.map((p) => p.slug);
  }

  if (!available.length) {
    console.log(`  ${dim(`(no premium plugin zips on this machine — run \`${CLI} setup\` to add them; continuing without)`)}`);
    return [];
  }

  console.log('\nWhich premium plugins should THIS project get?');
  // The scaffold passes its shared interface (see the freeze comment at its
  // creation); `resume` passes none and has no earlier prompts to stack
  // with, so a self-created one is safe there. Close only what we created.
  const rl = prompts ?? createInterface({ input: process.stdin, output: process.stdout });
  const selection = [];
  try {
    for (const plugin of availability) {
      if (!plugin.available) {
        // dim ·, never red ✖: a commercial plugin the user simply does not own
        // is not a failure — the same crying-wolf rule printAvailabilityTable
        // already follows for the identical fact.
        console.log(`  ${dim(INFO)} ${plugin.label} — no zip on this machine (run setup to add it), skipping`);
        continue;
      }
      const answer = (await rl.question(`? Install ${plugin.label}? [Y/n]: `)).trim();
      if (answer === '' || /^y(es)?$/i.test(answer)) selection.push(plugin.slug);
    }
  } finally {
    if (!prompts) rl.close();
  }
  if (selection.some((s) => s.startsWith('breakdance-')) && !selection.includes('oxygen')) {
    const oxygen = available.find((p) => p.slug === 'oxygen');
    if (oxygen) {
      console.log(`  ${dim('(adding Oxygen Builder — the selected extensions need it)')}`);
      selection.unshift('oxygen');
    }
  }
  return selection;
}

/** `rl` is the scaffold's SHARED prompt interface (see the comment where it is created) — this must not open its own. */
async function confirmScaffold(name, hostname, rl) {
  if (!process.stdin.isTTY) {
    bail(`${red(BAD)} Not scaffolding: confirm with --yes when running non-interactively.`);
    return false;
  }
  const answer = await rl.question(`? Scaffold a new WordPress site "${pink(name)}" at http://${hostname}? [y/N]: `);
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log('Cancelled.');
    return false;
  }
  return true;
}

/**
 * The missing-setup journey used to be one dim tip line, and everyone who
 * sailed past it got the WORST version of the product first: the classic
 * Laragon-reload flow, with its machine-wide Apache/MySQL blip, minutes of
 * vhost polling, and the reload-staleness failures instant mode exists to
 * delete. So an interactive scaffold that finds instant mode missing now
 * offers the enable inline — ONLY the mandatory half of setup (the wildcard
 * conf); the premium wizard stays setup's own business.
 *
 * This only WRITES the conf; the Stop All → Start All is deliberately
 * deferred (returns 'deferred'). The first version restarted here, and the
 * operator immediately asked the right question: a fresh machine then paid
 * TWO restarts in one scaffold — this one, plus the one that makes https
 * valid for the new site (Laragon only adds a site's name to its
 * certificate on restart, and the folder does not exist yet at this point).
 * Deferring until the folder exists lets ONE restart deliver both — see
 * awaitCombinedRestart. Declining, --yes and non-TTY runs keep the classic
 * path exactly as before.
 *
 * `rl` is the scaffold's SHARED prompt interface — this must not open its
 * own (see the comment where it is created for the freeze that rule fixes).
 */
async function offerInstantMode(rl) {
  const confAlready = wildcardConfInstalled();
  console.log(
    confAlready
      ? `${cyan(STEP)} Instant mode is installed but not active yet (the running Apache predates its conf).`
      : `${cyan(STEP)} Instant mode is not enabled. Enabling it makes this and every future scaffold instant:\n` +
          '  no Laragon reloads, no machine-wide Apache/MySQL blip, sites live the moment they exist.',
  );
  const answer = (await rl.question(`? Enable it now? The one-time cost is a full ${bold('Stop All → Start All')} in Laragon. [Y/n]: `)).trim();
  // Default is YES — this prompt exists because the old opt-in tip was
  // ignored, and Enter-through should land on the good path.
  if (/^n(o)?$/i.test(answer)) return false;
  if (!confAlready) {
    const { suffix } = await installWildcardConf();
    console.log(`${green(OK)} Wildcard vhost written (serves *${suffix} from www\\<name>\\public${sslCertPresent() ? ', http + https' : ''}).`);
  }
  console.log(
    `  ${dim('Not asking for the restart yet: it comes in a moment, once the site folder exists —')}\n` +
      `  ${dim(`then one restart activates instant mode${sslCertPresent() ? ' AND makes the new site\'s https valid' : ''}.`)}\n`,
  );
  return 'deferred';
}

/**
 * The single Stop All → Start All that a fresh machine's first scaffold
 * needs, placed at the only point where one restart can deliver everything:
 * the site folder now exists, so Laragon's restart both loads the wildcard
 * conf (instant mode, machine-wide, forever) and regenerates its certificate
 * with this site's name in it (browser-valid https). No [Y/n] — the user
 * opted in at the offer; this is the restart they were promised.
 *
 * Probe-with-retry rather than trusting the user's Enter: Apache takes a few
 * seconds to come back, and "you said it restarted" is exactly the kind of
 * assertion this codebase has learned not to build on. Returns false when it
 * never comes up, and the caller falls back to the classic flow rather than
 * dying — the folder already exists, which is all the classic path needs.
 *
 * Own short-lived readline interface: the shared one closed after the
 * premium picker (see the stdin freeze lore), and this runs seconds later.
 */
async function awaitCombinedRestart(hostname) {
  const httpsToo = sslCertPresent();
  console.log(
    `${cyan(STEP)} Now the one-time restart. In Laragon: ${bold('Stop All → Start All')}.\n` +
      `  This activates instant mode for every future scaffold${httpsToo ? `, and makes https://${hostname}\n  valid (the certificate regenerates to include the new site)` : ''}.`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('  Press Enter here once Laragon is back up… ');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await wildcardActive()) {
        console.log(`${green(OK)} Instant mode is ACTIVE — this scaffold needs no Laragon reload.\n`);
        return true;
      }
      if (attempt < 2) {
        console.log(`  ${yellow(WARN)} Not serving through the wildcard yet (Apache may still be starting). Press Enter to re-check…`);
        // Field-observed (2026-08-12): Laragon's own window stopped responding
        // during a Stop All, and closing and reopening it recovered. The advice
        // belongs HERE, at the moment the user is staring at a wedged tray app.
        console.log(`  ${dim('If Laragon itself has stopped responding, close and reopen it, Start All, then press Enter.')}`);
        await rl.question('');
      }
    }
    console.log(
      `${yellow(WARN)} Still not active — continuing with the classic Laragon-reload flow for this\n` +
        `  scaffold. Run \`${CLI} setup\` afterwards; it verifies instant mode and says what is missing.\n`,
    );
    return false;
  } finally {
    rl.close();
  }
}

/**
 * Instant-mode reachability probe: serve a token from the site's public/
 * through the wildcard vhost, over the loopback with an explicit Host
 * header — no DNS, no hosts-entry dependency, no per-site vhost. Replaces
 * verifyDocroot's dual-request dance (wrong-docroot is impossible when the
 * wildcard derives the docroot by convention).
 */
async function probeInstant(hostname, projectDir, { timeoutMs = 12_000, tls = false } = {}) {
  const token = randomBytes(12).toString('hex');
  const probeFile = join(projectDir, 'public', '.agentpress-probe.txt');
  await writeFile(probeFile, token, 'utf8');
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await fetchViaLoopback(hostname, '/.agentpress-probe.txt', { tls });
      if (res && res.status === 200 && res.body.trim() === token) return true;
      await sleep(750);
    }
    return false;
  } finally {
    await rm(probeFile, { force: true }).catch(() => {});
  }
}

/**
 * Does https serve THIS site in a way a BROWSER will accept — proven by a
 * token AND by the certificate actually naming the site?
 *
 * The scheme recorded here is not cosmetic: it goes into `.env` as SITE_SCHEME,
 * into wp-config's per-request WP_HOME, into the admin login link and into the
 * registry. The old test accepted any https response, and a wildcard conf
 * generated before Laragon's certificate existed answers :443 with Laragon's own
 * welcome page — so a site would record `https` while https served something that
 * was not the site. One short attempt, because a false negative merely records
 * `http`, which is always safe and always true.
 *
 * The cert check exists because a healthy TLS socket is NOT browser-valid
 * https: our probes skip validation, but Chrome refused a fresh site with
 * ERR_CERT_COMMON_NAME_INVALID (field, 2026-08-13) — Laragon only adds a
 * site's name to its certificate when IT restarts, and the `*.test` SAN
 * browsers get instead is a TLD-level wildcard they reject. Without this
 * gate the scaffold minted an https admin link the browser refused to open.
 */
async function httpsServesSite(hostname, projectDir) {
  if (!sslCertPresent()) return false;
  if (!(await certCoversHostname(hostname))) return false;
  return probeInstant(hostname, projectDir, { timeoutMs: 3000, tls: true });
}

/**
 * The one-restart path to a fully-https site, offered at the only moment it
 * can deliver one: the site's folder now exists, so a Laragon restart will
 * regenerate the certificate WITH this site's name in it — and the scheme
 * decided right after this is what gets baked into .env, the admin link and
 * every URL the panel prints.
 *
 * Field driver (operator, 2026-08-13): after the cert-honesty fix a new site
 * came out http, and a restart AFTER the scaffold didn't make it feel secure
 * either — the cert became valid but every link the tool had written still
 * said http. "It feels like a win but it's not." Offering the restart before
 * the scheme is recorded is what turns the same restart into an actually
 * https site.
 *
 * Its own SHORT-LIVED readline interface, deliberately: the scaffold's
 * shared one is closed minutes earlier (see the stdin freeze comment there),
 * and keeping that one open through the whole build would let a stray Enter
 * pressed during the long WordPress install buffer up and auto-answer this
 * prompt. Two interface cycles per run is the profile that was stable for
 * months; three BACK-TO-BACK was the freeze.
 */
async function offerHttpsForNewSite(hostname, projectDir) {
  console.log(
    `${cyan(STEP)} https for ${hostname} is one restart away: Laragon regenerates its certificate on\n` +
      '  restart and will include this new site. (Browsers reject the certificate\'s *.test\n' +
      '  wildcard, so a new site needs its own entry before https is trusted.)',
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`? Do the one-time ${bold('Stop All → Start All')} now, for a fully-https site? [Y/n]: `)).trim();
    if (/^n(o)?$/i.test(answer)) return false;
    console.log(`${cyan(STEP)} In Laragon: ${bold('Stop All → Start All')}. Press Enter here once it is back up…`);
    await rl.question('');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await certCoversHostname(hostname)) && (await probeInstant(hostname, projectDir, { timeoutMs: 5000, tls: true }))) {
        console.log(`${green(OK)} https://${hostname} is browser-valid — recording https for this site.\n`);
        return true;
      }
      if (attempt < 2) {
        console.log(`  ${yellow(WARN)} The certificate does not cover ${hostname} yet (Apache may still be starting). Press Enter to re-check…`);
        console.log(`  ${dim('If Laragon itself has stopped responding, close and reopen it, Start All, then press Enter.')}`);
        await rl.question('');
      }
    }
    console.log(
      `${yellow(WARN)} Still not valid — continuing with http, which works now. The summary explains how\n` +
        '  to get https later.\n',
    );
    return false;
  } finally {
    rl.close();
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
      `  ${dim('(A blank page is normal at this stage — WordPress is not installed yet.)')}` +
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
      // Only recommend resume for a folder that carries one of our own markers.
      // Recommending it for a folder we did not create is how a user gets talked
      // into overwriting their own checkout — resume now refuses those anyway,
      // so advising it here would just be a dead end.
      const mine = await agentPressMarkers(projectDir);
      if (!mine.length) {
        console.log(
          '\n  That folder has none of the files an AgentPress scaffold leaves behind, so it was\n' +
            '  almost certainly created by something else. Pick a different name, or move the\n' +
            '  folder aside first. (`resume` will not overwrite it either.)',
        );
      } else {
        const hasVhost = Boolean(await findVhostForProject(projectDir));
        console.log(
          hasVhost
            ? `\n  This looks like an interrupted scaffold — try: ${pink(`${CLI} resume ${name}`)}`
            : `\n  This looks like an interrupted scaffold with no vhost yet — open Laragon, click\n  Reload, wait for it to settle, then run: ${pink(`${CLI} resume ${name}`)}`,
        );
      }
    } else if (hasFolder && hasEnv && !hasSandbox) {
      console.log(`\n  This looks like a scaffold that failed near the end — try: ${pink(`${CLI} resume ${name}`)}`);
    } else if (hasFolder && hasEnv) {
      console.log(`\n  This site already exists. To remove it: ${pink(`cd ${projectDir}`)} then ${pink(`${CLI} destroy`)}`);
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
        `  ${dim(`(\`${CLI} doctor\` shows what was resolved.)`)}`,
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
  let instant = wildcardConfInstalled() && (await wildcardActive());
  // ONE readline interface for the whole interactive stretch — the offer, the
  // scaffold confirmation, and the premium picker. These were three
  // back-to-back interfaces, each cycling Windows stdin through
  // pause/resume, and on the offer flow's second real run the premium picker
  // froze solid: keys not echoed, question never resolving (field report,
  // 2026-08-12). libuv's Windows console reader cancels its pending read on
  // pause, and that cancellation can race the next interface's resume; two
  // interfaces got away with it for months, adding a third made it
  // intermittent. One interface, one resume, no cycles. Closed in the
  // finally below on EVERY path — an open interface keeps the process alive.
  const prompts = process.stdin.isTTY && !yes ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let premiumSelection;
  try {
  if (!instant && prompts) {
    // 'deferred' (truthy) when the user opts in: the conf is written but the
    // restart waits until the site folder exists, where one restart delivers
    // instant mode AND browser-valid https — see awaitCombinedRestart.
    instant = await offerInstantMode(prompts);
  } else if (wildcardConfInstalled() && !instant) {
    // Non-interactive (--yes, pipes): no prompt, keep the classic path and
    // say why it is slower.
    console.log(
      `${yellow(WARN)} Instant mode is installed but not active yet (Apache has not restarted since setup).\n` +
        '  Falling back to the classic Laragon-reload flow for this scaffold. One-time fix:\n' +
        `  ${bold('Stop All → Start All')} in Laragon, and every future scaffold skips reloads entirely.\n`,
    );
  } else if (!instant) {
    console.log(`  ${dim(`Instant mode is not enabled — using the classic Laragon-reload flow (slower). Run \`${CLI} setup\` once to fix.`)}\n`);
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
  // MySQL is needed for the database step, which is a long way in: the folder, the
  // UAC prompt and (in classic mode) a machine-wide Laragon reload all happen
  // first, and `preflight()` already knew MySQL was down before any of it. Checked
  // here, before the confirmation and before any side effect.
  //
  // Hard block in instant mode only. In classic mode the Laragon reload this
  // scaffold triggers can itself start MySQL, so refusing would reject a run that
  // would have worked — warn and let the confirmation carry the decision.
  if (!state.mysqlUp) {
    // Hard-block only when instant mode is ACTIVE (=== true): nothing ahead
    // would start MySQL. 'deferred' means a full Stop All → Start All is
    // coming before the database step, which starts MySQL too — same logic
    // as the classic reload below, so both get the warn-and-continue path.
    if (instant === true) {
      bail(
        `${red(BAD)} MySQL is not listening on :${MYSQL_PORT}, and this scaffold needs it to create the\n` +
          '  database. Click Start All in Laragon and try again.\n' +
          `  ${dim(`(If you moved MySQL, set AGENTPRESS_MYSQL_PORT. \`${CLI} doctor\` shows what was resolved.)`)}`,
      );
      return;
    }
    console.log(
      `${yellow(WARN)} MySQL is not listening on :${MYSQL_PORT} yet. The ${instant === 'deferred' ? 'one-time restart coming up' : 'Laragon reload this scaffold'}\n` +
        `  ${instant === 'deferred' ? 'should start it' : 'triggers may start it'} — if it does not, the run will stop at the database step and\n` +
        '  can be finished later with `resume`.\n',
    );
  }

  if (!yes && !(await confirmScaffold(name, hostname, prompts))) return;

  premiumSelection = await choosePremiumPlugins({ flagValue: typeof flags.premium === 'string' ? flags.premium : undefined, yes, prompts });
  } finally {
    prompts?.close();
  }

  const release = await acquireScaffoldLock();
  try {
    console.log(`${cyan(STEP)} Staging ${name} …`);
    await mkdir(join(stagingDir, 'public'), { recursive: true });
    // public/index.php first, even in staging — `wp core download` (Phase 4)
    // only refuses when it finds wp-load.php, so this placeholder is
    // harmless and gets overwritten by the real WordPress tarball later.
    await writeFile(join(stagingDir, 'public', 'index.php'), `<?php\n// ${STAGING_INDEX_MARKER} — replaced by \`wp core download\`\n`);
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
      // This file is also the earliest marker `resume` looks for, so losing it
      // costs more than the plugin choices: if the run then dies before .env
      // exists, the folder may carry no marker at all and resume will refuse it.
      console.log(
        `  ${dim(`(could not record this run's plugin choices: ${err.message}`)}\n` +
          `  ${dim(' to resume, pass --premium= explicitly, and add --adopt if resume says the folder is not ours)')}`,
      );
    });

    // Resolve a deferred instant-mode enable now that the folder exists — the
    // moment ONE restart can both load the wildcard conf and put this site's
    // name into Laragon's regenerated certificate. If the restart never takes,
    // fall back to the classic flow below rather than dying: the folder is in
    // place, which is all the classic path needs.
    if (instant === 'deferred') {
      if (await awaitCombinedRestart(hostname)) {
        instant = true;
        // That restart bounced MySQL too — refresh the stale preflight answer.
        state.mysqlUp = await mysqlUp();
      } else {
        instant = false;
      }
    }
    if (instant) {
      console.log(`${cyan(STEP)} Instant mode: no Laragon reload needed.`);
      // Kept, not discarded: every proof after this point uses loopback with an
      // explicit Host header, so a refused hosts write cannot fail any of them and
      // the panel would otherwise end in a green tick over URLs that resolve nowhere.
      const scaffoldWarnings = [];
      if (!(await ensureHostsEntryWithGuidance(hostname))) {
        scaffoldWarnings.push(`${hostname} has no hosts entry, so the URLs below will not resolve until you add it (see above)`);
      }
      if (!(await probeInstant(hostname, projectDir))) {
        bail(
          `${red(BAD)} The wildcard vhost did not serve ${hostname} within 12s — Apache may be down or the\n` +
            `  wildcard conf (${WILDCARD_CONF_PATH}) may have been removed.\n` +
            `  Run \`${CLI} doctor\`, fix what it reports, then:${resumeHint(name, extraPlugins, premiumSelection)}`,
        );
        return;
      }
      let scheme = (await httpsServesSite(hostname, projectDir)) ? 'https' : 'http';
      // The folder exists as of moments ago, which is what makes the offered
      // restart able to produce a certificate covering this site — see
      // offerHttpsForNewSite. Interactive runs only; --yes and pipes keep
      // http plus the summary warning.
      if (scheme === 'http' && !yes && process.stdin.isTTY && sslCertPresent() && !(await certCoversHostname(hostname))) {
        if (await offerHttpsForNewSite(hostname, projectDir)) {
          scheme = (await httpsServesSite(hostname, projectDir)) ? 'https' : 'http';
        }
      }
      console.log(`${green(OK)} ${scheme}://${hostname} is live (served by the wildcard vhost)`);
      // Say how to GET https when the machine plainly could serve it — and say the RIGHT
      // reason, because there are two distinct ones. New-site case (the common one):
      // Laragon only writes a site's name into its certificate when IT restarts, and the
      // `*.test` SAN browsers see instead is a TLD-level wildcard they reject — so a
      // fresh site's https is browser-invalid (ERR_CERT_COMMON_NAME_INVALID, field
      // 2026-08-13) until the next Stop All → Start All. Cert-covers-but-not-serving
      // case: the running Apache predates the wildcard conf's https half; same remedy,
      // different mechanism. Only when the cert EXISTS: with no cert, http is the only
      // option and there is nothing to act on, so mentioning it would be noise.
      if (scheme === 'http' && sslCertPresent()) {
        scaffoldWarnings.push(
          (await certCoversHostname(hostname))
            ? 'https is available on this machine but not being served yet — in Laragon do a\n' +
                `    one-time ${bold('Stop All → Start All')} (not just Reload), approving any Windows\n` +
                `    permission prompt. Then this site answers on https://${hostname}.`
            : "https for this new site isn't valid yet: Laragon adds a site's name to its\n" +
                `    certificate only when it restarts. Do a ${bold('Stop All → Start All')} in Laragon\n` +
                `    (approving any prompts) and https://${hostname} becomes valid. Every link\n` +
                '    below uses http, which works right now.',
        );
      }
      await finishInstall({ name, hostname, projectDir, extraPlugins, premiumSelection, scheme, warnings: scaffoldWarnings });
      return;
    }

    // Best-effort, exactly as in ensureHostsEntry: this is a BACKUP of a file
    // we are not the ones rewriting (Laragon's reload is), so an unreadable
    // hosts file or a full backups dir must not sink a scaffold whose project
    // folder is already in place.
    await snapshotHosts().catch((err) => {
      console.log(`  ${dim(`(could not back up the hosts file first: ${err.message} — continuing)`)}`);
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
          `  ${dim('(A blank page is normal at this stage — WordPress is not installed yet.)')}` +
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
            '  real restart once Apache has been up for a while. In Laragon, do a full\n' +
            `  ${bold('Stop All → Start All')} (not just Reload), then check http://${hostname}.\n` +
            `  ${dim('(A blank page is normal at this stage — WordPress is not installed yet.)')}` +
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
/**
 * `warnings` is threaded through this pair rather than printed where it happens,
 * and that is the whole point of it. Every signal it carries was already COMPUTED
 * and then thrown away, so the final panel could print a bare
 * "✓ WordPress is ready" for a site whose hostname does not resolve, whose .env
 * is being served over HTTP, whose containment guard is not loaded, or whose
 * "Admin" link is not the one-click link it looks like.
 *
 * The declined-UAC case is the one that mattered most and the easiest to miss:
 * both the docroot probe and the MCP handshake deliberately bypass DNS (loopback
 * plus an explicit Host header), so a hosts write the user refused cannot fail
 * either of them. The scaffold really did succeed; the URLs in the panel just did
 * not resolve, and nothing said so.
 */
async function finishInstall({ name, hostname, projectDir, extraPlugins = [], premiumSelection, scheme = 'http', warnings = [] }) {
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
    console.log(`  ${dim(`(note: a previous attempt left a database named ${sanitizeDbIdentifier(name, 64)} — this run uses ${db.dbName}; the old one is unused and safe to drop by hand)`)}`);
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
  if (!(await protectProjectSecrets({ name, projectDir }))) {
    warnings.push("this site's .env is being served over HTTP — see the SECURITY warning above");
  }

  await finishExtras({ name, hostname, projectDir, extraPlugins, premiumSelection, adminUser, adminPassword, adminEmail, siteUrl: `${scheme}://${hostname}`, scheme, warnings });
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
  // Read the wiring we are about to take over, BEFORE taking it over. Wiring
  // for cursor/opencode is machine-global and the newest scaffold wins, so
  // scaffolding site B silently repoints those agents away from site A — a
  // surprise that only `rewire` explained, even though a scaffold does exactly
  // the same thing. Claude Code is EXCLUDED since 1.10.0: its wiring is the
  // site's own .mcp.json, nothing global moves, so reporting it as displaced
  // would claim a theft that no longer happens (any legacy user-scope entry is
  // deliberately left where it points).
  const wiredBefore = await readWiredHostnames();
  const displaced = [
    ...new Set(
      Object.entries(wiredBefore)
        .filter(([key, h]) => key !== 'claude' && h && h !== hostname.toLowerCase())
        .map(([, h]) => h),
    ),
  ];
  // MCP deliberately stays on http: the proxy is a Node process whose trust
  // of Laragon's self-signed cert isn't guaranteed, and http always works.
  // siteDir rides along for configureClaude, which writes the site's own
  // .mcp.json rather than any machine-global config.
  const creds = {
    wpApiUrl: `http://${hostname}/wp-json/mcp/mcp-adapter-default-server`,
    username: adminUser,
    password: appPassword,
    siteDir: join(publicDir, '..'),
  };
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
    // No glyph in a step line: progress lines narrate, the summary judges —
    // reportMcpOutcome prints the real yellow ⚠ for this same fact.
    onStep(verification.ok ? `MCP endpoint answered (${verification.tools} tools)` : `the MCP endpoint did not answer: ${verification.detail}`);
    // A rejected credential is the one failure with a knowable cause, and the
    // probe that just failed used a password minted seconds ago — so "restart
    // your agent session" cannot be the explanation. Ask the site why.
    if (!verification.ok && /HTTP 40[13]/.test(verification.detail || '')) {
      verification.hints = await diagnoseAppPasswordAuth({ publicDir });
    }
  }
  return { detectedKeys, configuredAgents, failedAgents, verification, displaced };
}

/** The shared reporting for wireMcpForSite's outcome — identical for a scaffold and a rewire. */
function reportMcpOutcome({ detectedKeys, configuredAgents, failedAgents, verification, displaced = [] }) {
  const lines = [];
  if (!detectedKeys.length) {
    // Stating the fact was not enough: MCP is the headline feature, so the one
    // line about its absence should say how to get it.
    lines.push(`${dim('·')} No AI agent CLI found on PATH, so no MCP wiring was written (everything else is set up).`);
    lines.push(`  ${dim(`Install Claude Code, Cursor, Codex or OpenCode, then run \`${CLI} rewire\` from this folder.`)}`);
    return lines;
  }
  if (configuredAgents.length) {
    const health = verification ? (verification.ok ? `verified, ${verification.tools} tools` : `NOT verified: ${verification.detail}`) : 'not checked';
    lines.push(`${verification && !verification.ok ? yellow(WARN) : green(OK)} MCP wired for: ${configuredAgents.join(', ')} (${health})`);
  }
  // The one-time consent is part of the journey now, so say it here — the
  // alternative is the user's first launch hitting an unexplained security
  // prompt about executing code. Claude-only: the other CLIs stay global.
  if (configuredAgents.includes('claude')) {
    lines.push(`  ${dim("Claude Code is wired per-site (.mcp.json): its first launch here asks once to enable")}`);
    lines.push(`  ${dim("this site's MCP servers — approve both, and this site keeps its wiring forever.")}`);
  }
  // Machine-global wiring (cursor/opencode, and legacy claude entries):
  // whoever wired last owns it. A scaffold does this as silently as a rewire
  // did, and until now only rewire said so.
  if (displaced.length && configuredAgents.length) {
    lines.push(`  ${cyan(STEP)} Some agents were pointed at ${displaced.join(', ')} and now point here.`);
    lines.push(`    ${dim(`To switch back, run \`${CLI} rewire\` from that site's folder.`)}`);
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
  if (failedAgents.length) lines.push(`  ${cyan(STEP)} Retry with:  ${pink(`${CLI} rewire`)}   ${dim("(from this site's folder)")}`);
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
async function finishExtras({ name, hostname, projectDir, extraPlugins = [], premiumSelection, adminUser, adminPassword, adminEmail = 'admin@example.com', siteUrl, scheme = 'http', warnings = [] }) {
  const publicDir = join(projectDir, 'public');
  const onStep = (msg) => console.log(`  … ${msg}`);

  if (extraPlugins.length) {
    // Non-fatal per plugin now, so the failures have to reach the summary or this
    // trades a loud failure for a quiet one — which would be the worse bug.
    const { failed } = await installPlugins({ path: publicDir, plugins: extraPlugins, onStep });
    for (const f of failed) {
      warnings.push(`the plugin "${f.source}" was NOT installed (${f.reason}) — check the slug on wordpress.org`);
    }
  }

  // Always installed — Phase 7's MCP wiring depends on it, same as the
  // Docker original (which baked it into every scaffold regardless of the
  // user's own plugin selection).
  await installAgentConnector({ path: publicDir, onStep });

  // Re-asserted here, not only in installWordPress: this is the function that
  // installs the abilities pack, and it also runs for a `resume` whose
  // WordPress was installed by an OLDER version of this tool that never wrote
  // the guard. Idempotent, so the double-write on a fresh scaffold is free.
  if (!(await writeMcpLoopbackGuard(publicDir, { onStep }))) {
    warnings.push('the agent-API loopback guard is not in place — see the SECURITY warning above');
  }

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
    // Recorded so `list` can answer "which of my sites are behind?" without opening
    // each site's sandbox.config.json. recordEnvironment shallow-merges, so adding a
    // field is backward-compatible with registries written by older versions.
    version: ENGINE_VERSION,
    createdAt: new Date().toISOString(),
  });

  const admin = await mintAdminLoginUrl({ path: publicDir, hostname, scheme });
  if (!admin.oneClick) {
    warnings.push(`the Admin link is the ordinary login form, not a one-click link (${admin.reason}) — use the printed password`);
  }

  console.log(
    // The headline claim is now conditional on the warnings it used to talk over.
    // "✓ WordPress is ready" printed even when the hostname did not resolve, so a
    // user whose UAC prompt was declined got a green tick above three URLs that
    // went nowhere.
    (warnings.length
      ? `\n${yellow(WARN)} WordPress is installed and serving, with ${warnings.length} thing${warnings.length === 1 ? '' : 's'} to know:\n` +
        warnings.map((w) => `  ${yellow(WARN)} ${w}\n`).join('')
      : `\n${green(OK)} WordPress is ready.\n`) +
      // Always say something about MCP — the headline feature used to be simply
      // absent from this panel whenever nothing was wired, whether that was
      // because no agent CLI exists or because every one of them failed.
      `${reportMcpOutcome(mcp).map((l) => `${l}\n`).join('')}` +
      // Labels dim, values plain: the values are what gets copied, and a dim
      // label column reads as structure without stealing attention from them.
      `  ${dim('Site ')}  ${siteUrl}\n` +
      // The TTL was never mentioned to the human. A one-click link that has quietly
      // expired looks exactly like a broken site, and the menu can mint a fresh one.
      `  ${dim('Admin')}  ${admin.url}\n` +
      (admin.oneClick ? `         ${dim('one-time link, valid ~5 min — `npm run agentpress` mints a fresh one')}\n` : '') +
      `  ${dim('User ')}  ${adminUser}\n` +
      `  ${dim('Pass ')}  ${adminPassword}\n\n` +
      `  ${pink(`cd ${projectDir}`)}\n` +
      `  ${pink('npm run agentpress')}   ${dim('# open the menu')}\n` +
      // Only when something is actually wired: /verify tests the MCP path, so
      // suggesting it with no agent configured would send the user at a check
      // that cannot pass. This is the one moment they are looking at the
      // output, so it is where the feature has to be mentioned — the README is
      // not where anyone looks after a successful scaffold.
      // The holding page is built by Oxygen's html-to-page, so promising it on a
      // site scaffolded without Oxygen (the default for anyone with no licensed
      // zips) promises something verify.md then correctly refuses to do — it says
      // so explicitly, and tells the agent not to fake one. Four surfaces made
      // that promise unconditionally.
      // `/verify` is a Claude Code slash command. Telling a Cursor or Codex user to
      // "run /verify" names something their agent does not have, so point them at
      // the file instead — which is why AGENTS.md describes it that way too.
      (mcp.configuredAgents?.length
        ? `\n  Then open this folder in ${AGENT_LABELS[mcp.configuredAgents[0]] || 'your agent'} and ` +
          (mcp.configuredAgents.includes('claude') ? `run ${pink('/verify')} —\n` : `ask it to\n  follow ${pink('.claude/commands/verify.md')} —\n`) +
          (premiumPlugins.includes('oxygen')
            ? '  it exercises both MCP servers and Oxygen end to end, and builds the site a\n  holding page recording what passed.\n'
            : '  it exercises both MCP servers end to end. (No holding page: that is built with\n  Oxygen, which this site was scaffolded without.)\n')
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
  // Ownership check BEFORE anything is read or written. See agentPressMarkers:
  // this command overwrites public/, README.md, .gitignore and package.json, and
  // until now it would do that to any folder shaped like an unfinished scaffold,
  // including someone else's checkout.
  const markers = await agentPressMarkers(projectDir);
  if (!markers.length && !flagOn(flags.adopt)) {
    bail(
      `${red(BAD)} ${projectDir} does not look like an AgentPress site, so resume will not touch it.\n` +
        '  resume finishes an INTERRUPTED SCAFFOLD, and it overwrites public/, README.md,\n' +
        '  .gitignore and package.json. None of the files a scaffold leaves behind are here\n' +
        `  (${PENDING_SELECTION_FILE}, .env, sandbox.config.json, scripts/agentpress.mjs, or the\n` +
        '  placeholder public/index.php).\n' +
        '  If it really is an interrupted scaffold, re-run with --adopt to override.',
    );
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
  // Same reasoning as the scaffold path: this result decides whether the panel's
  // URLs resolve, and every later proof bypasses DNS so nothing else will catch it.
  const resumeWarnings = [];
  if (!(await hostsHasEntry(hostname))) {
    if (instant) {
      if (!(await ensureHostsEntryWithGuidance(hostname))) {
        resumeWarnings.push(`${hostname} has no hosts entry, so the URLs below will not resolve until you add it (see above)`);
      }
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
          `  In Laragon, do a full ${bold('Stop All → Start All')}, then retry resume.`,
      );
      return;
    }
  }
  console.log(`${green(OK)} http://${hostname} is live and serving from public\\`);

  // Same token proof as the scaffold path — an existing SITE_SCHEME still wins,
  // since that site already decided and resume must not silently change it.
  const scheme = env.SITE_SCHEME || ((await httpsServesSite(hostname, projectDir)) ? 'https' : 'http');

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
      `  ${dim(`(premium plugins: reusing this scaffold's original choice — ${premiumSelection.length ? premiumSelection.join(', ') : 'none'}; override with --premium=)`)}`,
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
        warnings: resumeWarnings,
      });
    } else {
      await finishInstall({ name, hostname, projectDir, extraPlugins, premiumSelection, scheme, warnings: resumeWarnings });
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
  // The MCP target is read back rather than assumed, same as doctor does: the entry
  // is machine-global and whichever site was wired last owns it.
  const wired = await readWiredHostnames();
  const targets = [...new Set(Object.values(wired).filter(Boolean))];
  console.log(
    formatEnvironmentsTable(await listEnvironments(), {
      cli: CLI,
      current: ENGINE_VERSION,
      // Only when the readable configs agree. Two different targets means the
      // machine is genuinely inconsistent, and marking one of them would be a guess.
      mcpTarget: targets.length === 1 ? targets[0] : null,
    }),
  );
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
    bail(notASiteDirMessage('rewire', cwd));
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
        `  ${dim(`(Currently in: ${cwd})`)}`,
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
        `  Then run ${pink('/verify')} in the agent to confirm the wiring end to end.`,
    );
  }
  // Exit non-zero when it did not work. This printed a ⚠ panel and exited 0, so
  // anything scripting `rewire` — a CI step, an agent chaining commands, a
  // `&&` in a shell — read a rejected credential as success. The only exit-1
  // path used to be "nothing was wired at all".
  if (result.verification?.ok === false || result.failedAgents?.length) {
    process.exitCode = 1;
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

/**
 * Refreshes one site's tooling files. Takes the directory as a parameter rather
 * than reading process.cwd() itself, which is what makes `update --all` possible
 * without a chdir. `announce` is false for the bulk path, where one shared
 * consent prompt has already been given and repeating the wall of text per site
 * would bury the per-site results.
 *
 * Returns true when the site was updated, false when it was skipped or refused,
 * so the bulk caller can report per-site outcomes instead of dying on the first
 * problem.
 */
async function updateProject({ yes, dir = process.cwd(), announce = true }) {
  const cwd = dir;
  let envContent;
  try {
    envContent = await readFile(join(cwd, '.env'), 'utf8');
  } catch {
    bail(notASiteDirMessage('update', cwd));
    return false;
  }
  // A bare .env is far too common to be the only gate — `update --yes` in
  // any random Node project with a .env used to gut its package.json and
  // overwrite README/.gitignore. Require an actual AgentPress marker.
  if (!(await isAgentPressSiteDir(cwd))) {
    bail(notASiteDirMessage('update', cwd));
    return false;
  }
  // An OLDER CLI silently downgraded a site's tooling and reported success, which
  // is the one direction of this command nobody expects. sandbox.config.json is
  // never overwritten by copyTemplates, so its recorded version survives to be
  // compared. compareVersionsDesc returns < 0 when its first argument is newer.
  const sandboxPath = join(cwd, 'sandbox.config.json');
  let sandbox = null;
  try {
    sandbox = JSON.parse(await readFile(sandboxPath, 'utf8'));
  } catch {
    // a very old site, or hand-edited — nothing to compare against
  }
  const siteVersion = sandbox?.updatedWithVersion || sandbox?.scaffolderVersion || null;
  if (siteVersion && compareVersionsDesc(siteVersion, ENGINE_VERSION) < 0) {
    bail(
      `${red(BAD)} This site was last touched by AgentPress v${siteVersion}, which is NEWER than the\n` +
        `  v${ENGINE_VERSION} you are running. Updating would replace its tooling with older files.\n` +
        `  Update the tool first:  ${pink('npm i -g create-agentpress@latest')}\n` +
        `  ${dim('(or re-run through `npx create-agentpress@latest update`, which always fetches the newest.)')}`,
    );
    return false;
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

  if (announce) {
    console.log(
      // AGENTS.md and .claude/ were missing from this list while being overwritten
      // by the same copyTemplates call. They are the two files a user is most likely
      // to have customised, since they are the agent's instructions for the site.
      "This refreshes scripts/, wp-cli.yml, .gitignore, README.md, AGENTS.md, .claude/,\n" +
        "package.json's known scripts, the MCP loopback guard mu-plugin, and the Oxygen\n" +
        'html-to-page patch. Your .env, sandbox.config.json, and any custom package.json\n' +
        'scripts are preserved. If you hand-edited any refreshed file, those edits will be\n' +
        'overwritten — take a backup first (a git commit, or a copy of the folder).',
    );
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      bail(`${red(BAD)} Not updating: confirm with --yes when running non-interactively.`);
      return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('? I understand — update now [y/N]: ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Cancelled.');
      return false;
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
  // Record WHICH version did this, in the one file update never overwrites. Without
  // it `list` cannot answer "which of my sites are behind?", and the downgrade guard
  // above has nothing to compare against.
  if (sandbox) {
    sandbox.updatedWithVersion = ENGINE_VERSION;
    await writeFile(sandboxPath, `${JSON.stringify(sandbox, null, 2)}\n`, 'utf8').catch(() => {});
  }
  await recordEnvironment({ dir: cwd, version: ENGINE_VERSION, updatedAt: new Date().toISOString() });
  console.log(`${green(OK)} Updated to v${ENGINE_VERSION}.`);
  return true;
}

/**
 * `update --all` over every site in the registry. The registry already knows every
 * site's directory, so the only thing missing was a loop — and the reason to build
 * it is that "update the tool" and "update each site" being different operations
 * was the single most confusing thing about this tool in practice.
 *
 * Deliberately: one consent prompt for the whole run rather than per site, the plan
 * printed BEFORE anything is touched, and a per-site outcome list at the end. It
 * must never abort on the first bad site — a bulk operation that stops half way is
 * worse than one that reports what it could not do.
 */
async function updateAllProjects({ yes }) {
  const environments = await listEnvironments();
  if (!environments.length) {
    console.log(formatEnvironmentsTable(environments, { cli: CLI }));
    return;
  }
  console.log(`This will refresh AgentPress's tooling files in ${environments.length} site${environments.length === 1 ? '' : 's'}:\n`);
  for (const e of environments) console.log(`  ${e.name || basename(e.dir)}${e.version ? dim(`  (last updated by v${e.version})`) : ''}\n    ${e.dir}`);
  console.log(
    `\nEach site's .env and sandbox.config.json are preserved. Hand-edited copies of the\n` +
      'refreshed files are not — take a backup first if that matters.',
  );
  if (!yes) {
    if (!process.stdin.isTTY) {
      bail(`${red(BAD)} Not updating: confirm with --yes when running non-interactively.`);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`? Update all ${environments.length} sites now [y/N]: `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Cancelled.');
      return;
    }
  }

  const results = [];
  for (const e of environments) {
    const label = e.name || basename(e.dir);
    console.log(`\n${cyan(STEP)} ${label}`);
    try {
      results.push({ label, ok: await updateProject({ yes: true, dir: e.dir, announce: false }) });
    } catch (err) {
      // One broken site must not strand the rest.
      console.log(`  ${yellow(WARN)} ${err.message}`);
      results.push({ label, ok: false });
    }
  }

  const done = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`${failed.length ? yellow(WARN) : green(OK)} Updated ${done.length} of ${results.length} sites to v${ENGINE_VERSION}.`);
  for (const f of failed) console.log(`  ${yellow(WARN)} ${f.label} was not updated — see its output above.`);
  if (failed.length) process.exitCode = 1;
}

/**
 * Run from within a site directory (like `update`). Order matters — see
 * destroy.mjs's own header for why MCP/app-password cleanup must happen
 * before the database is dropped, and the database before the vhost/folder.
 */
async function destroyCommand({ yes }) {
  const cwd = process.cwd();
  if (!(await fileExists(join(cwd, '.env')))) {
    bail(notASiteDirMessage('destroy', cwd));
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
        `  ${dim(`(Currently in: ${cwd})`)}`,
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
    `${bold(`This permanently removes ${cwd}`)}:\n` +
      '  - the database and its dedicated user\n' +
      '  - the WordPress application password this tool minted\n' +
      '  - MCP registrations for any agents this site configured\n' +
      '  - the vhost conf, the hosts entry this tool added, and this project directory\n' +
      `  ${dim('Removing the hosts entry needs a Windows permission prompt, like adding it did.')}\n` +
      `  ${dim('Declining it is fine — the leftover line is printed at the end instead.')}\n` +
      `${bold('This cannot be undone.')}`,
  );
  if (!yes) {
    if (!process.stdin.isTTY) {
      bail(`${red(BAD)} Not destroying: confirm with --yes when running non-interactively.`);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`? Type the site name (${pink(basename(cwd))}) to confirm: `);
    rl.close();
    if (answer.trim() !== basename(cwd)) {
      console.log('Cancelled.');
      return;
    }
  }

  // Wrapped so a throw mid-teardown still reports what DID complete. Without this,
  // an EPERM on the very last step (an editor holding a file open) printed a bare
  // stack and told the user nothing about the database, the vhost or the MCP entries
  // that had already gone.
  let result;
  try {
    result = await destroySite({ projectDir: cwd, onStep: (msg) => console.log(`  … ${msg}`) });
  } catch (err) {
    // EBUSY/EPERM on the project directory has one overwhelmingly common cause, and
    // the generic message did not name it: Windows holds a handle on every process's
    // current directory, so a shell sitting IN the folder blocks the rmdir. This code
    // already chdir's ITSELF out (see destroy.mjs) but it cannot move the parent
    // shell, which is exactly where a user runs this from — `cd` into the site, then
    // destroy it. Reported from the field on a real teardown that got as far as
    // dropping the database and removing the vhost before failing here.
    const locked = /EBUSY|EPERM|ENOTEMPTY/.test(err.code || '') || /EBUSY|EPERM|ENOTEMPTY/.test(err.message || '');
    bail(
      `${red(BAD)} Teardown stopped part-way: ${err.message}\n` +
        '  Anything reported above as done IS done — only the steps after it were skipped.\n' +
        // Ordered by what actually happened in the field, not by what sounds likely.
        // The reported case was an EDITOR INDEXING the tree (VS Code plus two PHP
        // language servers over ~2000 WordPress files), which is a race: the folder
        // itself was never held — renaming it worked — and deleting the entries one at a
        // time then succeeded on every one. An earlier version of this message blamed
        // the shell's current directory and said to remove the folder from elsewhere;
        // that is a real cause too, but it was NOT this one, and asserting it sent the
        // user to a command that also failed.
        (locked
          ? '  Something is holding a file inside it. Usually an editor or language server\n' +
            '  indexing the WordPress tree, or a virus scanner mid-pass — a race, not a\n' +
            '  permanent lock, which is why the retries above may simply need another go.\n' +
            '\n' +
            `  The folder is all that is left. Try again first:   ${pink(`${CLI} destroy`)}\n` +
            '  If it still refuses, close any editor open on the folder, then remove it\n' +
            '  from a shell that is NOT inside it:\n' +
            `    ${pink(`Remove-Item -Recurse -Force ${cwd}`)}\n` +
            '  Deleting the entries one at a time works when a whole-tree delete will not.\n' +
            `  \`${CLI} list\` prunes the entry once the folder is gone.\n`
          : `  Re-running \`${CLI} destroy\` here is safe — every step re-checks before acting,\n` +
            '  and the database drop is idempotent.'),
    );
    return;
  }

  // The registry entry is the user's index of their sites. Keeping it while the
  // site still exists is correct: a halted teardown has not removed anything the
  // entry describes, and forgetting it would hide the site from `list`.
  if (!result.halted) await forgetEnvironment(cwd);

  if (result.halted) {
    bail(
      `${red(BAD)} Teardown HALTED before anything was deleted, because the database could not be\n` +
        `  dropped: ${result.dbSkipReason}\n\n` +
        '  The site folder, its vhost and its .env are all still here, and .env is the only\n' +
        `  record of the database name and user — so nothing was stranded.\n` +
        `  Fix the cause (usually: start MySQL) and re-run \`${CLI} destroy\`.\n` +
        // @'127.0.0.1', NOT @'localhost'. provisionDatabase creates the user as
        // 127.0.0.1 and dropDatabase drops that exact grant, so a hand-typed
        // localhost variant is a silent no-op under IF EXISTS — it would report
        // success and leave the MySQL user behind. Keep these two in step with
        // src/mysql.mjs; a test pins them.
        (result.recovery?.dbName
          ? '\n  Or drop it by hand and re-run:\n' +
            `    DROP DATABASE IF EXISTS \`${result.recovery.dbName}\`;\n` +
            `    DROP USER IF EXISTS '${result.recovery.dbUser}'@'127.0.0.1';\n`
          : ''),
    );
    return;
  }

  // A password we could not confirm revoked is not a blemish once its database is
  // gone, so it must not hold the tick back either — otherwise the panel says ⚠ over
  // a teardown with nothing left to do.
  const clean = result.dbDropped;
  console.log(
    // No leading ✓ unless everything actually worked. It used to print one over
    // "(database not dropped: ...)" in the same sentence.
    `\n${clean ? green(OK) : yellow(WARN)} Destroyed.${result.removedAgents.length ? ` MCP entries removed for: ${result.removedAgents.join(', ')}.` : ''}` +
      `${result.dbDropped ? ' Database dropped.' : ` (database not dropped: ${result.dbSkipReason})`}\n` +
      // The preamble above promises this credential is removed, so a failure to
      // revoke belongs in the SUMMARY, not only in a step line that scrolled
      // past mid-teardown. It is an admin-equivalent REST credential and the
      // site is about to stop existing, so it cannot be revoked later.
      // Conditional on the database, and that matters. Application passwords live in
      // the site's own wp_usermeta, so once the database is dropped the credential is
      // gone with it — there is nothing left to revoke and no wp-admin to revoke it
      // in. Sending someone to wp-admin at that point is advice they cannot follow,
      // which is how this read on a real teardown. The warning is only true when the
      // database SURVIVED.
      (result.appPasswordRevoked === null && !result.dbDropped
        ? `\n${yellow(WARN)} The application password could NOT be confirmed revoked, and the database is\n` +
          '  still here, so it may still grant REST admin. Remove it in wp-admin ▸ Users ▸\n' +
          '  Profile ▸ Application Passwords.\n'
        : '') +
      (result.appPasswordRevoked === null && result.dbDropped
        ? `\n${dim('·')} ${dim('The application password could not be confirmed revoked, but the database it')}\n` +
          `  ${dim('lived in has been dropped, so it no longer exists. Nothing to do.')}\n`
        : '') +
      // Four hosts outcomes, three of them printed. Removed cleanly: say so, with
      // the right plural — destroy takes the site's `#laragon magic!` line as well
      // as our own (the operator's field test showed Laragon prunes dead magic
      // lines only when a NEW folder appears in www, never on a service
      // Stop/Start, so after the last site it lingered forever). Something still
      // resolving the hostname: name it, because "removed" while it still
      // resolves would read as a lie — but do NOT guess who wrote it: `remaining`
      // counts ANY resolving line, including a tagged one at a non-loopback
      // address, which the remover deliberately skips. Removal failed: the old
      // "Remaining trace" line plus the reason — v1 of this feature emptied the
      // whole hosts file, so every failure path now leaves the file alone and
      // this line is the fallback (see hostsRemovalScript). Nothing there to
      // begin with: print nothing.
      (result.hostsEntry?.ok && result.hostsEntry.removed > 0 && result.hostsEntry.remaining.length === 0
        ? `\nHosts ${result.hostsEntry.removed > 1 ? 'entries' : 'entry'} removed.\n`
        : '') +
      (result.hostsEntry?.ok && result.hostsEntry.remaining.length > 0
        ? `\n${dim(INFO)} ${dim(`Remaining trace: a hosts line still maps ${result.hostname}, and it is not one this`)}\n` +
          `  ${dim('tool may remove (it only removes single-hostname loopback lines tagged by itself')}\n` +
          `  ${dim('or Laragon). It was left alone — remove it by hand if it is unwanted.')}\n`
        : '') +
      (result.hostsEntry && !result.hostsEntry.ok && result.hostname
        ? `\n${dim(INFO)} ${dim(`Remaining trace: a hosts entry for ${result.hostname} — safe to leave, or remove by hand.`)}\n` +
          `  ${dim(`(not removed automatically: ${result.hostsEntry.reason})`)}\n`
        : ''),
  );
  if (!result.dbDropped && result.dbSkipReason !== 'no database recorded in .env') process.exitCode = 1;
  // Same condition as the warning above: an unrevoked password whose database has
  // been dropped is not an outstanding problem, so it must not fail the command.
  if (result.appPasswordRevoked === null && !result.dbDropped) process.exitCode = 1;
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

/**
 * The single refusal for "this is not an AgentPress site folder". Three copies of
 * this existed and all three disagreed: two said "a agentpress site directory",
 * one named `scripts\katalyst.mjs` — the pre-rename filename that no site
 * scaffolded since v1.2.0 has — and none of them said which folder the user was
 * actually standing in, or how to find their sites. `isAgentPressSiteDir` still
 * accepts the old name, so only the message was wrong.
 */
function notASiteDirMessage(command, cwd) {
  return (
    `${red(BAD)} \`${command}\` runs from inside a scaffolded site's folder, and this is not one.\n` +
    '  It looks for .env, plus sandbox.config.json or scripts/agentpress.mjs.\n' +
    `  Currently in:  ${cwd}\n` +
    `  Your sites:    ${CLI} list`
  );
}

/**
 * Which files that AgentPress itself writes are present in this folder. The
 * ownership question `resume` has to answer before it overwrites anything.
 *
 * `resume` used to accept ANY folder under www\ that had a `public\` and no
 * `.env`, which is also the exact shape of a freshly cloned WordPress project
 * whose `.env` is gitignored — and resuming one overwrites `public/`,
 * `README.md`, `.gitignore` and `package.json`. Worse, the scaffold's own
 * name-collision message actively recommended `resume` for that folder.
 *
 * The list is ordered by when a scaffold writes each one, so it covers every
 * window an interrupted run can die in:
 *   - public/index.php placeholder  written into the staging dir first of all
 *   - .agentpress-pending.json      immediately after the staging rename
 *   - .env                          once the database and WordPress are in
 *   - sandbox.config.json / scripts/  the extras phase, i.e. nearly complete
 *
 * Returns the markers found rather than a boolean so the refusal can name what
 * it looked for. An empty array is the "not ours, do not touch it" answer.
 */
export async function agentPressMarkers(projectDir) {
  const found = [];
  if (await fileExists(join(projectDir, PENDING_SELECTION_FILE))) found.push(PENDING_SELECTION_FILE);
  // A bare `.env` is NOT enough. It is one of the commonest files in any web
  // project and is routinely gitignored, which is exactly the shape this gate
  // exists to reject — accepting it would have left half the hole open. Ours
  // always carries SITE_HOST (see finishInstall), and rewire/destroy both read
  // that key, so its presence is what actually identifies the file as ours.
  try {
    const env = await readFile(join(projectDir, '.env'), 'utf8');
    if (/^SITE_HOST=/m.test(env)) found.push('.env with SITE_HOST');
  } catch {
    // absent or unreadable: not one of the markers
  }
  if (await isAgentPressSiteDir(projectDir)) found.push('sandbox.config.json or scripts/agentpress.mjs');
  // Last, because this only matters for a run that died inside the staging
  // window, before `wp core download` replaced the placeholder.
  try {
    const index = await readFile(join(projectDir, 'public', 'index.php'), 'utf8');
    if (index.includes(STAGING_INDEX_MARKER)) found.push('public/index.php (scaffold placeholder)');
  } catch {
    // absent or unreadable: not one of the markers
  }
  return found;
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
  // `dim('·')` for a missing zip, never `red(BAD)`. These are commercial plugins the
  // user may simply not own, and this table is the FIRST output of the second command
  // a stranger runs — four red ✖ marks read as four failures on a healthy machine,
  // which is precisely the crying-wolf that teaches people to ignore the glyph column.
  console.log(`\n${bold('Premium plugins')} ${dim('(optional — your own licensed zips)')}`);
  for (const p of availability) {
    console.log(`  ${p.available ? green(OK) : dim('·')} ${p.label.padEnd(52)} ${p.available ? basename(p.zip) : dim('no zip yet')}`);
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
      console.log(`\n  To make a plugin available, drop your licensed zip into:\n    ${pink(dir)}`);
      console.log(`  ${dim(`Expected filenames: ${missing.map((p) => `${p.slug}[-*].zip`).join(', ')}`)}`);
      console.log(`  ${dim('(Or keep them in your own private GitHub releases repo — premiumPluginsRepo in config.json, see the README.)')}`);
      const open = (await rl.question('? Open that folder in Explorer now so you can drop zips in? [y/N]: ')).trim();
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
    const answer = (await rl.question(`\n? Oxygen license key (one key covers all the extensions; ${hint}): `)).trim();
    if (answer) {
      config.licenses = { ...(config.licenses || {}), oxygen: answer };
      if (!/^[a-f0-9]{32}$/i.test(answer)) {
        console.log(`  ${dim('(saved — note it does not look like the usual 32-character key, double-check if activation fails)')}`);
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
  // Mirrors the scaffold and resume gates: without laragon.exe there is nowhere
  // to write a vhost, and the failure that follows is a confusing filesystem
  // error rather than the one thing the user needs to hear.
  if (!state.laragonInstalled) {
    bail(
      `${red(BAD)} No laragon.exe found under the resolved Laragon root, so there is nowhere to install\n` +
        '  the wildcard vhost. If Laragon lives somewhere unusual, set AGENTPRESS_LARAGON_ROOT to\n' +
        '  its folder (e.g. D:\\laragon) and re-run setup.',
    );
    return;
  }

  // Say what this command is about to do. `setup` prints nothing before its first
  // prompt, and its first output is a table of red ✖ marks for commercial plugins
  // the user has not bought — on the second command a stranger ever runs.
  // Same visual language as printUsage: bold headers, pink for the things the
  // user types or acts on, dim for meta — the status glyphs keep their meaning.
  console.log(
    `${bold('Setup')} does two things, and only the first is required:\n` +
      `  ${pink('1')}  a single wildcard vhost, so scaffolding a site never needs a Laragon reload\n` +
      `  ${pink('2')}  optionally, registering your own licensed premium plugin zips (Oxygen and\n` +
      '     friends). Skip it and everything still works — sites just get no premium\n' +
      '     plugins unless you add zips later.\n',
  );

  // The MANDATORY half runs FIRST. It used to sit after all the optional prompts,
  // so abandoning the licence-key question — which a user has no reason to expect —
  // cost them the wildcard vhost, the entire reason the command exists, with
  // nothing printed to say it had been skipped.
  const { suffix, updated } = await installWildcardConf();
  if (updated) {
    console.log(`${green(OK)} Wildcard vhost written to ${WILDCARD_CONF_PATH} (serves *${suffix} from www\\<name>\\public${sslCertPresent() ? ', http + https' : ''})`);
  } else {
    console.log(`${green(OK)} Wildcard vhost already current at ${WILDCARD_CONF_PATH}`);
  }
  if (!sslCertPresent()) {
    console.log(`  ${dim("(no Laragon SSL cert found — https will light up if you enable SSL in Laragon's menu and re-run setup)")}`);
  }

  // Optional half, and it must stay AFTER the wildcard install above and BEFORE the
  // verification below — the early returns further down would otherwise skip it.
  await setupPreferences();

  if (!state.apacheUp) {
    console.log(
      `${cyan(STEP)} Apache is not running — click ${bold('Start All')} in Laragon, then run ${pink(`${CLI} setup`)} again to verify.\n` +
        `\n  ${dim('All commands:')} ${pink(`${CLI} help`)}`,
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
          ? `  ${dim("(https uses Laragon's own certificate — if the browser warns about trust, enable")}\n` +
            `   ${dim("SSL once in Laragon's menu, which registers the cert with Windows.)")}\n`
          : '') +
        '\n  Setup is done — you never need to run it again on this machine (unless you\n' +
        '  want to add plugin zips or change the license key).\n' +
        `\n  ${dim('Next: create your first site with')}  ${pink(`${CLI} my-site`)}\n` +
        `  ${dim('All commands:')} ${pink(`${CLI} help`)}`,
    );
    return;
  }
  if (httpLive && !httpsLive) {
    console.log(
      `\n${cyan(STEP)} http is live, but the https half of the wildcard needs the running Apache to\n` +
        `  reload the updated conf. ONE-TIME step: in Laragon, do a full ${bold('Stop All → Start All')},\n` +
        `  then run ${pink(`${CLI} setup`)} again to confirm.\n` +
        `\n  ${dim('All commands:')} ${pink(`${CLI} help`)}`,
    );
    return;
  }
  console.log(
    `\n${cyan(STEP)} Not active yet — the running Apache predates the conf. ONE-TIME step:\n` +
      `  in Laragon, do a full ${bold('Stop All → Start All')} (not just Reload), then run\n` +
      `  ${pink(`${CLI} setup`)} again to confirm. After that, no scaffold ever needs a reload.\n` +
      `\n  ${dim('All commands:')} ${pink(`${CLI} help`)}`,
  );
}

async function registerQuickAppCommand() {
  const result = await registerQuickApp();
  if (!result.added) {
    console.log(`${dim(INFO)} Not added: ${result.reason}.`);
    return;
  }
  console.log(
    `${green(OK)} Added an "AgentPress" entry to sites.conf (backed up to ${result.backup}).\n` +
      "  Reopen Laragon's tray menu (Quick app) to see it.\n" +
      `  ${dim("Note: Quick app's own AutoCreateDatabase will also create a plain DB named after the")}\n` +
      `  ${dim("project — this tool's own DB (a differently-named, dedicated user) is what the site")}\n` +
      `  ${dim('actually uses; the Quick-app-created one is unused and safe to drop by hand.')}`,
  );
}

function printUsage() {
  // The pink wordmark is already above this — create() prints it for every
  // command — so help only styles its body. Pad the RAW cell, then colour:
  // ANSI escapes count toward String.length, so colouring first silently
  // eats columns (the rule doctor's layout lives by). Everything degrades to
  // exactly the old plain text under NO_COLOR / a pipe, where pink() and
  // bold() are identity functions.
  const row = (cell, desc, width) => `  ${pink(cell.padEnd(width))}  ${desc}`;
  const cmd = (c, d) => row(c, d, 22);
  const env = (n, d) => row(n, d, 31);
  console.log(
    [
      '',
      `${bold('create-agentpress')} v${ENGINE_VERSION} — local WordPress + AI-agent dev environments on Laragon`,
      '',
      `${bold('Usage')}  ${CLI} ${pink('<command>')} ${dim('[flags]')}`,
      '',
      `${bold('First time here?')} Three commands, in this order: ${pink('doctor')} ${dim(STEP)} ${pink('setup')} ${dim(STEP)} ${pink('<name>')}`,
      '',
      bold('Commands'),
      cmd('doctor', "Check this machine's Laragon/PHP/MySQL/Node state (changes nothing)"),
      cmd('setup', 'Once per machine — see the note below'),
      cmd('<name>', 'Scaffold a WordPress site at http://<name>.test (or your Laragon suffix)'),
      cmd('resume <name>', 'Finish an interrupted scaffold'),
      cmd('list', 'List scaffolded sites'),
      cmd('register-quick-app', 'Add a Laragon Quick app entry for this tool'),
      '',
      bold('Inside a scaffolded site'),
      cmd('update', "Refresh AgentPress's own tooling files"),
      cmd('update --all', 'The same, for every site in `list` (run from anywhere)'),
      cmd('rewire', "Point the AI agents' MCP connection back at THIS site"),
      cmd('destroy', 'Permanently remove that site'),
      cmd('npm run agentpress', 'The site menu: admin login, DB snapshots, recent errors'),
      cmd('/verify', 'In an agent: exercise both MCP servers and Oxygen end to end'),
      '',
      `${pink('setup')} does two things. It installs one wildcard vhost, so scaffolding a site never`,
      'needs a Laragon reload; and it optionally registers your own licensed premium plugin',
      'zips (Oxygen and friends). The premium half is skippable — everything works without it.',
      '',
      bold('Flags'),
      cmd('--yes, -y', 'Skip confirmation prompts'),
      cmd('--plugins=a,b', 'Extra wordpress.org plugins for this site'),
      cmd('--premium=all|none|a,b', 'Which premium plugins this site gets'),
      cmd('--adopt', 'resume: proceed on a folder with no AgentPress marker (it will be overwritten)'),
      cmd('--force-name', 'Scaffold a site whose name looks like a mistyped command'),
      cmd('--help, -h', 'This screen'),
      cmd('--version, -v', 'Print the version'),
      `  ${dim('Values attach with =, not a space: --premium=none, never --premium none.')}`,
      '',
      bold('Environment'),
      env('AGENTPRESS_LARAGON_ROOT', "Laragon folder, when it can't be auto-detected"),
      env('AGENTPRESS_MYSQL_ROOT_PASSWORD', 'MySQL root password, when root has one'),
      env('AGENTPRESS_MYSQL_PORT', 'MySQL port, when not 3306'),
      env('AGENTPRESS_PREMIUM_PLUGINS_REPO', 'Where your licensed premium plugin zips live'),
      env('AGENTPRESS_OXYGEN_LICENSE', 'Oxygen key (`setup` can store it for you instead)'),
      env('AGENTPRESS_NO_BANNER', 'Hide the wordmark'),
      env('NO_COLOR / FORCE_COLOR', 'Colour off / on'),
      '',
    ].join('\n'),
  );
}

const KNOWN_FLAGS = new Set(['plugins', 'premium', 'adopt', 'force-name', 'all']);

/**
 * Is a boolean flag on? The same trap as environment variables (see `envOn` in
 * ansi.mjs): `--adopt` yields boolean `true`, but `--adopt=true` yields the
 * STRING `'true'`, and a bare `!== true` check rejects it. That turned both of
 * this pass's own escape hatches into dead ends — the refusal said "add
 * --force-name", and `--force-name=true` was then refused by the very message
 * recommending it. Found in review, because only the bare spelling was tested.
 *
 * A bare `--adopt=` counts as on; nobody writes that meaning "off". An explicit
 * false/0/no counts as off, so the flag can be scripted either way.
 */
function flagOn(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['', 'true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * The value each VALUE_FLAG should be shown as an example. Per-flag on purpose:
 * a shared template built the example from the flag name, so the `--plugins`
 * refusal recommended `--plugins=none` — and `none` is not a special value there,
 * it is a literal wordpress.org slug. Installing it fails, and installPlugins is
 * the first step of finishExtras, so the scaffold dies AFTER the database, the
 * database user and WordPress exist. Worse, the poison value is echoed back into
 * the printed resume hint and parked in .agentpress-pending.json, so a bare
 * `resume` replays it. Recommending a value must therefore be flag-specific.
 */
const VALUE_FLAG_EXAMPLE = { premium: '--premium=none', plugins: '--plugins=wordpress-seo' };

/**
 * Flags that are meaningless without a value. `parseArgs` only splits on `=`, so
 * `--premium none` sets the flag to boolean `true` and drops `none` into the
 * positionals — and because the call site forwards the value only when it is a
 * string, the selector fell through to its non-interactive default of EVERY
 * available plugin. `--premium none --yes` therefore installed and licensed every
 * commercial plugin on the machine, the exact opposite of what was typed.
 * Refused now rather than guessed at, because guessing wrong here is expensive
 * either way (install what was declined, or decline what was wanted).
 */
const VALUE_FLAGS = new Set(['plugins', 'premium']);
/** Commands that act on the current directory and take no site name. */
const CWD_COMMANDS = new Set(['update', 'rewire', 'destroy']);
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

/**
 * Anything not a known command becomes a SITE NAME and scaffolds, so this is the
 * only thing standing between a mistyped command and a provisioned site.
 *
 * A flat `editDistance <= 2` was far too loose in the one direction that costs
 * something: it matched `test`, `host`, `best` and `hello` against `list`/`help`,
 * i.e. several of the likeliest throwaway site names anyone types. Two extra
 * conditions keep the real typos and drop those: the lengths must be within one
 * of each other, and a distance of 2 counts only for words of 6+ characters.
 *
 * The length floor alone lost every transposition of a SHORT command (`lsit`,
 * `hlep`, `setpu`), so an adjacent swap is matched explicitly instead. That is
 * tight rather than fuzzy: none of the ordinary site names above is a
 * transposition of any command, so it costs nothing to include.
 *
 * Pinned by a matrix in test/argv-safety.test.mjs, in both directions, because
 * this gates a refusal and not merely a warning.
 */
function isAdjacentSwap(a, b) {
  if (a.length !== b.length) return false;
  const diff = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff.push(i);
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
}

export function closestCommand(word) {
  const w = word.toLowerCase();
  for (const cmd of KNOWN_COMMANDS) {
    if (w === cmd) continue;
    if (isAdjacentSwap(w, cmd)) return cmd;
    if (Math.abs(w.length - cmd.length) > 1) continue;
    const distance = editDistance(w, cmd);
    if (distance === 1 || (distance === 2 && w.length >= 6)) return cmd;
  }
  return null;
}

/**
 * Every argument refusal, as a PURE function of the parsed args. Returns the
 * refusal message, or null when the invocation is acceptable.
 *
 * Each rule replaces a silent misinterpretation on a command that provisions or
 * deletes. Two of them were outright destructive: `destroy <other-site> --yes`
 * ignored the name and deleted the folder you were standing IN, and
 * `--premium none` (a space instead of `=`) installed and licensed EVERY
 * commercial plugin, the exact opposite of what was typed.
 *
 * Pure, and extracted from create() for a reason that is not tidiness. The first
 * version lived inline, so the only way to test it was to call create() — and
 * the only way to prove those tests were load-bearing was to disable a guard and
 * let the same argv through. Doing that scaffolded a site called `destory`:
 * folder, database, database user, registry entry and a re-pointed
 * machine-global MCP wiring, on the maintainer's own machine. That is precisely
 * the harm these rules exist to prevent, so the rules must be checkable without
 * executing anything. Keep this function free of side effects.
 */
export function refuseInvocation(args) {
  if (args.stray.length) {
    // Any `-word` is a two-dash flag missing a dash. The first version gated this
    // hint on a hand-listed regex, which both missed the two flags this very pass
    // introduced and told a user nothing when it did not match.
    const looksLikeAFlag = args.stray.some((s) => /^-[a-z][a-z-]/i.test(s));
    const hint = looksLikeAFlag ? ' (flags take two dashes: --yes, --premium=none)' : '';
    return `${red(BAD)} Unrecognised argument ${args.stray.join(' ')}${hint} — refusing rather than ignoring it silently.`;
  }

  for (const flag of Object.keys(args.flags)) {
    if (VALUE_FLAGS.has(flag) && args.flags[flag] === true) {
      const consequence =
        flag === 'premium'
          ? '\n  Left unset, a run with --yes installs EVERY premium plugin on this machine,\n  which is the opposite of --premium=none.'
          : '\n  Left unset, no extra plugins are installed at all.';
      return (
        `${red(BAD)} --${flag} needs its value attached with =, e.g. \`${VALUE_FLAG_EXAMPLE[flag]}\`.` +
        `${consequence}\n  A value written after a space is not read as the flag's value.`
      );
    }
    // A near-miss of a value flag is worse than an unknown flag, because the
    // fallback is not "do nothing": `--premim=none --yes` leaves premium unset,
    // and unset under --yes means install EVERY premium zip. The blanket
    // unknown-flag warning above cannot be promoted to a refusal (it is the only
    // forward-compat escape, and README documents accepted-but-unimplemented
    // flags), so the refusal is narrowed to names that are plainly a misspelling.
    if (!KNOWN_FLAGS.has(flag)) {
      const meant = [...VALUE_FLAGS].find((known) => flag.toLowerCase() === known || editDistance(flag.toLowerCase(), known) <= 2);
      if (meant) {
        return (
          `${red(BAD)} Unknown flag --${flag} — did you mean --${meant}?\n` +
          `  Refused rather than ignored because --${meant} left unset is not neutral: with --yes it\n` +
          `  ${meant === 'premium' ? 'installs EVERY premium plugin on this machine' : 'installs no extra plugins at all'}.`
        );
      }
    }
  }

  if (args.command && CWD_COMMANDS.has(args.command) && args.positional.length > 1) {
    const extra = args.positional.slice(1);
    return (
      `${red(BAD)} \`${args.command}\` acts on the site folder you are standing in, so it cannot take` +
      ` ${extra.map((e) => `"${e}"`).join(', ')}.\n` +
      '  This is a refusal because it used to be ignored SILENTLY: with --yes,\n' +
      '  `destroy <other-site>` destroyed the folder you were IN, not the one you named.\n' +
      `  To act on ${extra[0]}:  cd ${join(WWW_DIR, extra[0])}   then re-run \`${CLI} ${args.command}\`.`
    );
  }

  if (args.command) {
    // Provably safe to refuse rather than fall through to scaffolding:
    // validateSiteName rejects any uppercase character, so a capitalised command
    // can never have been a legitimate site name anyway.
    const lower = args.command.toLowerCase();
    if (lower !== args.command && KNOWN_COMMANDS.has(lower)) {
      return `${red(BAD)} Commands are lowercase — did you mean \`${CLI} ${lower}\`?`;
    }
    // Interactively, the warning in the dispatch fallback plus confirmScaffold's
    // "[y/N]" is enough: a human sees the name before anything happens. Under
    // --yes there is no such step, and agent CLIs pass --yes by default.
    const close = closestCommand(args.command);
    if (close && args.yes && !flagOn(args.flags['force-name'])) {
      return (
        `${red(BAD)} "${args.command}" looks like a mistyped \`${close}\`, and --yes means there is no\n` +
        '  confirmation step to catch it. Scaffolding would create a folder, a database and a\n' +
        // Conditional because wireMcpForSite no-ops when no agent CLI is on PATH,
        // and a refusal that overstates what would have happened is the same
        // failure as the "restart your agent session" line this project already fixed.
        '  database user, and (if an agent CLI is installed) re-point this machine\'s MCP\n' +
        '  wiring at the new site.\n' +
        `  Did you mean:  ${CLI} ${close}\n` +
        `  Or, if you really want a site named "${args.command}":  add --force-name`
      );
    }
    // The scaffold path had the SAME silently-dropped-positional bug the cwd
    // commands did, and it is not harmless there: `${CLI} create mysite --yes`
    // provisions a folder, database and user under the name "create" and discards
    // "mysite" without a word. Refused last so a genuine typo still gets the
    // clearer message above.
    if (!KNOWN_COMMANDS.has(args.command) && args.positional.length > 1) {
      const extra = args.positional.slice(1);
      return (
        `${red(BAD)} Expected one site name, but got ${args.positional.map((p) => `"${p}"`).join(' ')}.\n` +
        `  Only the first is used, so this would have created a site named "${args.command}" and\n` +
        `  silently discarded ${extra.map((e) => `"${e}"`).join(', ')}.\n` +
        '  Site names cannot contain spaces — use hyphens, e.g. `my-site`.'
      );
    }
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

  const refusal = refuseInvocation(args);
  if (refusal) {
    bail(refusal);
    return;
  }

  if (args.command === 'version') {
    console.log(`create-agentpress v${ENGINE_VERSION}`);
    return;
  }

  if (args.command === 'doctor') {
    await runDoctor({ cli: CLI, version: ENGINE_VERSION });
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
    if (flagOn(args.flags.all)) await updateAllProjects({ yes: args.yes });
    else await updateProject({ yes: args.yes });
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
    // The --yes case was refused up in refuseInvocation; this is the interactive
    // path, where confirmScaffold still shows the name before anything happens.
    const close = closestCommand(args.command);
    if (close) {
      console.log(`${yellow(WARN)} "${args.command}" looks like a mistyped command (did you mean "${close}"?) — treating it as a SITE NAME to scaffold.`);
    }
    await scaffoldSite(args.command, { flags: args.flags, yes: args.yes });
    return;
  }

  printUsage();
}
