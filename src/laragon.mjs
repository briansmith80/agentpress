// Laragon vhost/hostname machinery: reload+poll, reverse vhost lookup by
// ROOT, verify-and-repair, hosts snapshot, service pre-flight, suffix
// inference.
//
// Confirmed live against this machine (Phase 0, 2026-07-30) — every function
// here is written assuming all four:
//   1. `laragon.exe reload` is fire-and-forget. The first call didn't exit
//      within 120s; it leaves a resident GUI process running rather than
//      signalling an existing one and returning. NEVER await its exit —
//      spawn detached and poll for effects instead.
//   2. ROOT is NEVER re-derived once a conf exists. Adding public/index.php
//      to an already-vhosted bare-docroot folder and reloading twice (with a
//      23s wait) did not change ROOT. There is no "fix it after the fact"
//      path — the tree must be complete *before* Laragon first sees it.
//   3. The hosts-file write can stall for MINUTES on an unattended UAC
//      prompt (Laragon writes hosts through an elevated helper). The vhost
//      conf can appear (~20s) long before the hosts line does.
//   4. CRITICAL: a reload took Apache down outright for the WHOLE machine
//      (all 86+ other sites, not just the one being scaffolded) — three
//      times across this session. Sometimes it came back on its own within
//      the existing poll window; sometimes it needed the user to click
//      Start All. Every reload here must be re-verified against a live
//      Apache afterward, and the caller must warn the user up front that
//      this is a shared-state action, not a scoped one.
//   5. Tried and reverted: having this module relaunch httpd.exe itself when
//      down. It DID bring the TCP port back — with a stale in-memory config
//      that served every pre-existing site but silently 404'd the brand-new
//      one, even though `httpd -t` said the on-disk config was fine. A raw
//      relaunch races whatever Laragon itself is doing and can win with an
//      outdated snapshot. Conclusion: never spawn a competing Apache
//      process. Detect, wait patiently (pollForVhost treats "down" as just
//      another thing to wait out within its budget), and if it's still down
//      when time runs out, tell the user to check Laragon — nothing here
//      starts a service on its own initiative.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { HOSTS_PATH, LARAGON_EXE, SITES_ENABLED_APACHE, BACKUPS_DIR } from './paths.mjs';
import { processRunning, psCapture, sleep, tcpProbe } from './win.mjs';
import { MYSQL_PORT } from './mysql.mjs';
import { spawnCapture } from './wp.mjs';

function normalizePath(p) {
  return p.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
}

export async function laragonRunning() {
  return processRunning('laragon');
}

/** A single TCP probe can flake under load (observed twice live: one false "not listening" while curl 200'd concurrently) — a genuinely closed port fails all retries in ~1.2s, so retry before declaring it down. */
async function probeWithRetry(port, { attempts = 3, delayMs = 600 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (await tcpProbe(port)) return true;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}

export async function apacheUp() {
  return probeWithRetry(80);
}

export async function mysqlUp() {
  return probeWithRetry(MYSQL_PORT);
}

// Cached while Apache is confirmed healthy, purely for the read-only `-t`
// config-syntax diagnostic below — see the file header for why the tool
// never spawns httpd.exe itself to "recover" it.
let cachedApacheExe = null;

async function findApacheExe() {
  const { code, stdout } = await psCapture(
    "(Get-CimInstance Win32_Process -Filter \"Name='httpd.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath)",
  );
  if (code !== 0) return null;
  return stdout.trim() || null;
}

/**
 * Pre-flight required before touching the filesystem or DB — do not depend
 * on `laragon.exe start` (unverified, and starting is not the same risk as
 * reload); just check and tell the caller what to do. Also opportunistically
 * caches httpd.exe's path while it's healthy, for testApacheConfig().
 *
 * `webServer` discriminates WHO owns port 80 — a bare port probe cannot:
 * Laragon in Nginx mode and a foreign listener (IIS, another Apache) both
 * answer on :80 and previously sailed through preflight, then failed 3+
 * minutes later with advice that couldn't work. This tool is Apache-only;
 * callers must gate on 'apache' before scaffolding.
 */
export async function preflight() {
  const [running, apache, mysql, httpdRunning] = await Promise.all([
    laragonRunning(),
    apacheUp(),
    mysqlUp(),
    processRunning('httpd'),
  ]);
  let webServer = 'none';
  if (apache) {
    if (httpdRunning) webServer = 'apache';
    else webServer = (await processRunning('nginx')) ? 'nginx' : 'foreign';
  }
  if (apache && webServer === 'apache' && !cachedApacheExe) {
    cachedApacheExe = await findApacheExe();
  }
  return {
    ready: running && apache && webServer === 'apache',
    laragonRunning: running,
    laragonInstalled: existsSync(LARAGON_EXE),
    apacheUp: apache,
    mysqlUp: mysql,
    webServer,
  };
}

/**
 * `httpd.exe -t` — surfaces a config syntax error explicitly rather than
 * leaving the caller to guess why a site isn't reachable after we've
 * rewritten a conf ourselves. Read-only: parses the on-disk config without
 * touching the running process.
 *
 * Deliberately NOT paired with any self-relaunch. Confirmed live
 * (2026-07-30): a raw `spawn(httpd.exe)` after a reload-triggered outage did
 * bring the TCP port back up, but with a STALE in-memory config — it served
 * every pre-existing site correctly while 404ing the brand-new one, even
 * though `-t` against the same on-disk config said "Syntax OK". The spawned
 * process's own config snapshot predated the moment Laragon (or whatever
 * else was mid-reload) finished writing that one vhost — i.e. self-relaunch
 * races Laragon's own process management and can win with an outdated view.
 * A silent 404 reads as "this site doesn't exist," which is worse than a
 * clear connection-refused "Apache is down." So: only ever detect and
 * report here — recovery is either Laragon's own reload settling on its own
 * (observed to happen within the existing poll window) or the user clicking
 * Start All. This tool never starts a competing Apache process.
 */
export async function testApacheConfig() {
  if (!cachedApacheExe) return { ok: null, output: '(no cached httpd.exe path — Apache was never seen healthy this run)' };
  const result = await spawnCapture(cachedApacheExe, ['-t'], { cwd: dirname(cachedApacheExe) });
  return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

/**
 * Majority-vote the hostname suffix from existing auto.*.conf filenames
 * rather than hardcoding ".test" — laragon.ini has no explicit pattern key
 * on this machine, but two ".local" vhosts already exist, proof the default
 * can be (and has been) changed in Preferences.
 */
export async function inferHostnameSuffix() {
  let names;
  try {
    names = await readdir(SITES_ENABLED_APACHE);
  } catch {
    return { suffix: '.test', votes: 0, sample: 0 };
  }
  const counts = new Map();
  let total = 0;
  for (const f of names) {
    const m = f.match(/^auto\..+\.([a-z0-9-]+)\.conf$/i);
    if (!m) continue;
    const tld = m[1].toLowerCase();
    counts.set(tld, (counts.get(tld) || 0) + 1);
    total += 1;
  }
  let best = 'test';
  let bestCount = 0;
  for (const [tld, count] of counts) {
    if (count > bestCount) {
      best = tld;
      bestCount = count;
    }
  }
  return { suffix: `.${best}`, votes: bestCount, sample: total };
}

/**
 * Find the vhost for a project by scanning every conf's `define ROOT` for
 * one that resolves under `projectDir` — never construct the filename from
 * the hostname pattern. This is what makes repair correct under any pattern
 * and is the only reliable way to detect a wrong (project-root) docroot.
 */
export async function findVhostForProject(projectDir) {
  const target = normalizePath(projectDir);
  let files;
  try {
    files = await readdir(SITES_ENABLED_APACHE);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.conf')) continue;
    const full = join(SITES_ENABLED_APACHE, f);
    let content;
    try {
      content = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    const rootMatch = content.match(/define\s+ROOT\s+"([^"]+)"/i);
    if (!rootMatch) continue;
    const root = normalizePath(rootMatch[1]);
    if (root !== target && !root.startsWith(`${target}\\`)) continue;
    const siteMatch = content.match(/define\s+SITE\s+"([^"]+)"/i);
    return {
      file: full,
      filename: f,
      root: rootMatch[1],
      hostname: siteMatch ? siteMatch[1] : null,
      isAuto: f.toLowerCase().startsWith('auto.'),
      isPublicDocroot: root === `${target}\\public`,
    };
  }
  return null;
}

export async function hostsHasEntry(hostname) {
  try {
    const content = await readFile(HOSTS_PATH, 'utf8');
    const needle = hostname.toLowerCase();
    return content
      .split('\n')
      .some((line) => line.toLowerCase().split(/\s+/).includes(needle) && !line.trim().startsWith('#'));
  } catch {
    return false;
  }
}

/**
 * Laragon rewrites the ENTIRE hosts file from a temp copy on every sync, and
 * a Docker Desktop block lives at the end of it — snapshot before any reload
 * we trigger so there's a way back if a rewrite ever loses something.
 * Backups are capped at the 10 newest — one per scaffold adds up forever
 * otherwise.
 */
export async function snapshotHosts() {
  await mkdir(BACKUPS_DIR, { recursive: true });
  const content = await readFile(HOSTS_PATH, 'utf8');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(BACKUPS_DIR, `hosts.${stamp}`);
  await writeFile(dest, content, 'utf8');
  try {
    const old = (await readdir(BACKUPS_DIR))
      .filter((f) => f.startsWith('hosts.'))
      .sort()
      .reverse()
      .slice(10);
    for (const f of old) await rm(join(BACKUPS_DIR, f), { force: true });
  } catch {
    // pruning is best-effort
  }
  return dest;
}

/**
 * Fire-and-forget by design (see file header, point 1) — spawn detached and
 * return immediately. Do NOT await exit; the caller must poll for effects.
 * The 'error' listener matters: without it, a missing/invalid laragon.exe
 * (wrong LARAGON_ROOT) emits an unhandled 'error' event that kills the whole
 * Node process OUTSIDE any try/catch, leaking the scaffold lock. Preflight
 * gates on laragonInstalled, so this firing means something raced us — log
 * and let the poll time out with its own advice.
 */
export function triggerReload() {
  let child;
  try {
    child = spawn(LARAGON_EXE, ['reload'], { detached: true, stdio: 'ignore', shell: false });
  } catch (err) {
    console.log(`  (could not launch ${LARAGON_EXE}: ${err.message})`);
    return;
  }
  child.on('error', (err) => {
    console.log(`  (could not launch ${LARAGON_EXE}: ${err.message})`);
  });
  child.unref();
}

/**
 * Poll after a reload for both the vhost conf and the hosts entry to exist —
 * budgeted in minutes, not the ~60s a container-era assumption would
 * suggest, because the hosts write can stall on an unattended UAC prompt.
 *
 * Apache going down mid-reload is treated as just another thing to wait
 * out, NOT an early abort: it has been observed to come back on its own
 * (Laragon's own restart, or the user clicking Start All) within the same
 * window that's already being spent waiting on the hosts file. Only if it's
 * STILL down when the full timeout elapses does 'apache-down' become the
 * reported reason — see the file header for why the tool never tries to
 * relaunch Apache itself.
 */
/**
 * The `hostname` argument is only the pre-reload GUESS (majority-voted
 * suffix, defaulting to .test on a fresh install). Once the vhost conf
 * appears, its own `define SITE` is authoritative — a friend whose Laragon
 * uses a different pretty-URL suffix would otherwise wait the full timeout
 * on a hosts entry that will never match. Returns the effective hostname so
 * the caller can adopt it for everything downstream (.env, MCP, URLs).
 */
export async function pollForVhost(projectDir, hostname, { timeoutMs = 180_000, onTick } = {}) {
  const start = Date.now();
  let warnedUac = false;
  let warnedApacheDown = false;
  let warnedRename = false;
  const effectiveHostname = (vhost) => vhost?.hostname || hostname;
  while (Date.now() - start < timeoutMs) {
    const vhost = await findVhostForProject(projectDir);
    const target = effectiveHostname(vhost);
    if (vhost?.hostname && vhost.hostname !== hostname && !warnedRename) {
      warnedRename = true;
      onTick?.(`Laragon named this site ${vhost.hostname} (expected ${hostname}) — following Laragon's name.`);
    }
    const [hostsEntry, apache] = await Promise.all([hostsHasEntry(target), apacheUp()]);
    if (apache && vhost && hostsEntry) {
      return { ok: true, vhost, hostsEntry, hostname: target, elapsedMs: Date.now() - start };
    }
    const elapsed = Date.now() - start;
    if (!apache) {
      if (!warnedApacheDown) {
        warnedApacheDown = true;
        onTick?.('Apache is not responding — still waiting (it has come back on its own before; check Laragon if this goes on for a while).');
      }
    } else if (!warnedUac && elapsed > 8000 && vhost && !hostsEntry) {
      warnedUac = true;
      onTick?.('vhost created — waiting on the hosts file. Check your screen for a Windows permission prompt.');
    } else {
      onTick?.(vhost ? 'vhost created, waiting for hosts entry…' : 'waiting for Laragon to generate the vhost…');
    }
    await sleep(1500);
  }
  const vhost = await findVhostForProject(projectDir);
  const target = effectiveHostname(vhost);
  const [hostsEntry, apache] = await Promise.all([hostsHasEntry(target), apacheUp()]);
  return { ok: false, reason: apache ? 'timeout' : 'apache-down', vhost, hostsEntry, hostname: target, elapsedMs: timeoutMs };
}

/**
 * Distinguishes three outcomes with two requests rather than trusting a bare
 * HTTP 200 — Apache's 00-default.conf is a catch-all with `Require all
 * granted` over the whole www\ tree, so ANY unmatched Host also returns 200
 * (a directory listing of every site on the machine).
 */
export async function verifyDocroot(hostname, projectDir) {
  const token = randomBytes(12).toString('hex');
  const probeRelPublic = join(projectDir, 'public', '.katalyst-probe.txt');
  const probeRelRoot = join(projectDir, '.katalyst-probe.txt');
  await writeFile(probeRelPublic, token, 'utf8');
  try {
    const [rootBody, publicBody] = await Promise.all([
      fetchText(`http://${hostname}/.katalyst-probe.txt`),
      fetchText(`http://${hostname}/public/.katalyst-probe.txt`),
    ]);
    if (rootBody === token) return { ok: true, outcome: 'correct-docroot' };
    if (publicBody === token) return { ok: false, outcome: 'wrong-docroot-is-project-root' };
    return { ok: false, outcome: 'vhost-missing-or-unreachable' };
  } finally {
    await rm(probeRelPublic, { force: true }).catch(() => {});
    await rm(probeRelRoot, { force: true }).catch(() => {});
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

/**
 * Rewrite ROOT to `<projectDir>\public` and, if the conf is Laragon-owned
 * (`auto.` prefix), rename it to drop the prefix so Laragon preserves it
 * going forward (verified live: `spectraiq.test.conf` has survived untouched
 * with no `auto.` twin on this machine).
 */
export async function repairVhost(vhostInfo, projectDir) {
  const content = await readFile(vhostInfo.file, 'utf8');
  const fixedRoot = `${projectDir}\\public`.replace(/\\/g, '/');
  const rewritten = content.replace(/define\s+ROOT\s+"[^"]+"/i, `define ROOT "${fixedRoot}"`);
  let targetFile = vhostInfo.file;
  if (vhostInfo.isAuto) {
    targetFile = join(SITES_ENABLED_APACHE, vhostInfo.filename.replace(/^auto\./i, ''));
  }
  await writeFile(targetFile, rewritten, 'utf8');
  if (targetFile !== vhostInfo.file) {
    await rm(vhostInfo.file, { force: true });
  }
  return targetFile;
}
