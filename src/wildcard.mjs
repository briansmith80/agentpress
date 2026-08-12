// "Instant mode": one wildcard vhost, installed ONCE, that maps every
// <name><suffix> hostname to <www>/<name>/public via mod_vhost_alias. After
// a single one-time Apache restart, scaffolding a site needs NO Laragon
// reload, NO per-site vhost, and NO machine-wide Apache/MySQL blip — the
// whole reload-staleness failure class (reproduced on 3 of 3 scaffolds on
// one machine) is deleted from the architecture rather than worked around.
//
// Placement facts this relies on (verified live):
//   - Laragon's httpd.conf ends with `IncludeOptional sites-enabled/*.conf`,
//     and preserves non-`auto.` files there across its own reloads.
//   - Apache matches name-based vhosts FIRST-MATCH-IN-CONFIG-ORDER (not most
//     specific), and includes glob alphabetically — hence the `zzz-` prefix,
//     so every existing exact-name conf keeps winning over the wildcard.
//   - mod_vhost_alias.so ships with Laragon's Apache builds (unloaded);
//     LoadModule is legal inside an included conf, guarded by <IfModule>.
//   - Laragon's global <Directory "www"> is AllowOverride None — per-site
//     confs grant All on their own roots, so the wildcard brings its own
//     grant, scoped to */public only.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HOSTS_PATH, SITES_ENABLED_APACHE, WWW_DIR } from './paths.mjs';
import { psCapture, psQuote } from './win.mjs';
import { hostsContentEntryAddresses, inferHostnameSuffix, snapshotHosts } from './laragon.mjs';

export const WILDCARD_CONF_PATH = join(SITES_ENABLED_APACHE, 'zzz-agentpress-wildcard.conf');
const LEGACY_WILDCARD_CONF_PATH = join(SITES_ENABLED_APACHE, 'zzz-katalyst-wildcard.conf'); // pre-rename installs
const LARAGON_CRT = join(SITES_ENABLED_APACHE, '..', '..', 'ssl', 'laragon.crt');
const LARAGON_KEY = join(SITES_ENABLED_APACHE, '..', '..', 'ssl', 'laragon.key');

export function wildcardConfInstalled() {
  return existsSync(WILDCARD_CONF_PATH) || existsSync(LEGACY_WILDCARD_CONF_PATH);
}

export function sslCertPresent() {
  return existsSync(LARAGON_CRT) && existsSync(LARAGON_KEY);
}

async function generateWildcardConf() {
  const { suffix } = await inferHostnameSuffix();
  const www = WWW_DIR.replace(/\\/g, '/');
  const crt = LARAGON_CRT.replace(/\\/g, '/');
  const key = LARAGON_KEY.replace(/\\/g, '/');
  // The 443 vhost is only EMITTED when the cert pair exists — a
  // SSLCertificateFile pointing at a missing file is a hard Apache startup
  // failure, which would take down every site on the machine. Laragon's
  // cert carries a *.test wildcard SAN (verified live), so one cert covers
  // every future site with no regeneration.
  const sslBlock = sslCertPresent()
    ? `
<IfModule ssl_module>
<VirtualHost *:443>
    ServerName agentpress-wildcard${suffix}
    ServerAlias *${suffix}
    UseCanonicalName Off
    VirtualDocumentRoot "${www}/%1/public"
    SSLEngine on
    SSLCertificateFile      "${crt}"
    SSLCertificateKeyFile   "${key}"
</VirtualHost>
</IfModule>
`
    : '';
  const conf = `# agentpress "instant mode" wildcard vhost (conf v2: http + https) —
# managed by create-agentpress; \`setup\` regenerates it.
# Maps every <name>${suffix} to ${www}/<name>/public with no per-site vhost and no
# Laragon reload. The zzz- filename keeps this LAST in Apache's first-match vhost
# order, so exact-name confs for existing sites always win. Delete this file (and
# restart Apache) to disable.
<IfModule !vhost_alias_module>
    LoadModule vhost_alias_module modules/mod_vhost_alias.so
</IfModule>
<VirtualHost *:80>
    ServerName agentpress-wildcard${suffix}
    ServerAlias *${suffix}
    UseCanonicalName Off
    VirtualDocumentRoot "${www}/%1/public"
</VirtualHost>
${sslBlock}# .htaccess support for wildcard-served sites — scoped to */public trees only
# (Laragon's global www grant is AllowOverride None; its per-site confs add All
# per root, which the wildcard can't do per site).
<Directory "${www}/*/public">
    AllowOverride All
    Require all granted
</Directory>
`;
  return { suffix, conf };
}

/** Writes the conf only when it differs from what's on disk; `updated: true` means the running Apache is now behind and needs the one-time restart to pick the changes up. */
export async function installWildcardConf() {
  const { suffix, conf } = await generateWildcardConf();
  const existing = await readFile(WILDCARD_CONF_PATH, 'utf8').catch(() => null);
  const legacyPresent = existsSync(LEGACY_WILDCARD_CONF_PATH);
  if (legacyPresent) await rm(LEGACY_WILDCARD_CONF_PATH, { force: true }); // duplicate wildcard vhosts otherwise
  if (existing === conf && !legacyPresent) return { suffix, path: WILDCARD_CONF_PATH, updated: false };
  await writeFile(WILDCARD_CONF_PATH, conf, 'utf8');
  return { suffix, path: WILDCARD_CONF_PATH, updated: true };
}

/**
 * HTTP over the loopback with an explicit Host header — DNS never enters
 * the picture, which both makes probes hosts-entry-independent and dodges
 * the Windows DNS-cache staleness that can make a fresh hostname
 * unresolvable right after a restart.
 */
export function fetchViaLoopback(hostname, path, { timeoutMs = 3000, tls = false } = {}) {
  return new Promise((resolve) => {
    const mod = tls ? https : http;
    const options = {
      host: '127.0.0.1',
      port: tls ? 443 : 80,
      path,
      headers: { Host: hostname },
      timeout: timeoutMs,
    };
    if (tls) {
      // SNI must carry the site name even though we connect by IP, and the
      // probe asserts REACHABILITY, not trust — Laragon's cert is
      // self-signed, its browser trust is Laragon's own concern.
      options.servername = hostname;
      options.rejectUnauthorized = false;
    }
    const req = mod.request(options, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Conf-on-disk is not conf-in-Apache (the one-time restart may not have
 * happened yet, and the running process's stale-config failure mode is
 * exactly what this project keeps re-learning) — so activity is proven by
 * serving a real token from a throwaway folder through the wildcard, never
 * inferred from files.
 */
export async function wildcardActive({ tls = false } = {}) {
  if (!wildcardConfInstalled()) return false;
  const { suffix } = await inferHostnameSuffix();
  const name = `ap-probe-${randomBytes(4).toString('hex')}`;
  const token = randomBytes(12).toString('hex');
  const dir = join(WWW_DIR, name, 'public');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'agentpress-probe.txt'), token, 'utf8');
    const res = await fetchViaLoopback(`${name}${suffix}`, '/agentpress-probe.txt', { tls });
    return Boolean(res && res.status === 200 && res.body.trim() === token);
  } catch {
    return false;
  } finally {
    await rm(join(WWW_DIR, name), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Shared with findCollisions and (in spirit) the elevated script, so all three
 * presence checks agree. The previous local copy tokenised the whole line
 * including trailing comments, so a hostname mentioned in another line's
 * comment ("# was blog.test, retired") read as already-present here while
 * findCollisions read it as absent — ensureHostsEntry then skipped the write
 * and reported "already present" for a hostname that resolved nowhere.
 */
function hostsHas(content, hostname) {
  return hostsContentEntryAddresses(content, hostname).length > 0;
}

/** The $hosts assignment shared by both elevated scripts; tests override the path to drive the real script against a temp file, unelevated. */
function hostsPathExpr(hostsPath) {
  return hostsPath ? psQuote(hostsPath) : "(Join-Path $env:SystemRoot 'System32\\drivers\\etc\\hosts')";
}

/**
 * Both script generators single-quote hostnames into an ELEVATED script, so
 * the character check must live here, not only in the callers — a guard in
 * a different function is one refactor away from not running (the same
 * lesson runElevated's psQuote comment records for %TEMP%). Throws rather
 * than returns: a name failing this deep is a caller bug, not user input.
 */
function assertScriptSafeHostname(hostname) {
  if (!/^[a-z0-9.-]+$/i.test(String(hostname))) {
    throw new Error(`refusing to embed suspicious hostname "${hostname}" in an elevated script`);
  }
}

/** Runs a script elevated (one UAC prompt) and returns psCapture's result — the child's exit code flows through Start-Process. */
async function runElevated(script) {
  const tmp = join(tmpdir(), `agentpress-hosts-${randomBytes(6).toString('hex')}.ps1`);
  await writeFile(tmp, script, 'utf8');
  try {
    // psQuote, not a bare '${tmp}'. %TEMP% contains the Windows account name, so an
    // apostrophe in it ("O'Brien") closed the PowerShell string early and broke the
    // hosts write permanently for that user — reported to them, wrongly, as "the
    // elevation prompt was declined", which no retry could fix.
    return await psCapture(
      `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(tmp)}; exit $p.ExitCode`,
    );
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * The elevated append. Exported so tests can run the REAL script against a
 * temp file — the shipped bytes, not a re-implementation of them.
 *
 * The presence re-check inside the elevated script must be TOKEN-EXACT, the
 * same test hostsHas() does. It used to be `-notmatch [regex]::Escape($name)`,
 * a substring match: with myblog.test already in hosts, scaffolding "blog"
 * found "blog.test" inside "myblog.test", skipped the write, and the caller —
 * which re-reads hosts and correctly finds no entry — then reported "the
 * elevation prompt was declined", which was false and no retry could fix.
 */
export function hostsAppendScript(hostname, { hostsPath = null } = {}) {
  assertScriptSafeHostname(hostname);
  return [
    `$hosts = ${hostsPathExpr(hostsPath)}`,
    `$name = '${hostname}'.ToLower()`,
    '$present = $false',
    'foreach ($line in @(Get-Content -Path $hosts -ErrorAction SilentlyContinue)) {',
    '  $text = $line.Trim()',
    "  if ($text -eq '' -or $text.StartsWith('#')) { continue }",
    "  $tokens = @(($text -split '#')[0].ToLower() -split '\\s+' | Where-Object { $_ -ne '' })",
    // Skip token 0: that field is the address, never a hostname.
    '  if ($tokens.Count -ge 2 -and ($tokens[1..($tokens.Count - 1)] -contains $name)) { $present = $true }',
    '}',
    'if (-not $present) {',
    // The separator is CONDITIONAL on the file's last byte. It used to be a flat
    // "`r`n" prefix on every append, which put a blank line above every entry the
    // moment the file already ended with a newline — i.e. always, since Laragon
    // keeps it that way. The operator read the doubled spacing off their real
    // hosts file next to Laragon's single-spaced block. Defaulting to the prefix
    // when the tail can't be read is deliberate: a stray blank line is cosmetic,
    // an entry glued onto the previous line is broken.
    '  $prefix = "`r`n"',
    '  try {',
    '    $raw = [System.IO.File]::ReadAllText($hosts)',
    '    if ($raw.Length -eq 0 -or $raw.EndsWith("`n")) { $prefix = \'\' }',
    '  } catch {}',
    '  Add-Content -Path $hosts -Value ($prefix + "127.0.0.1`t" + $name + "`t#agentpress") -NoNewline:$false',
    '}',
    'exit 0',
  ].join('\r\n');
}

/**
 * Appends the hosts entry OURSELVES via one elevated PowerShell run (UAC
 * prompt), instead of waiting minutes on Laragon's elevated helper mid-
 * reload. Never fatal: a declined prompt returns ok:false and the caller
 * prints the exact line to add by hand — WordPress installation itself
 * needs no DNS, so the scaffold can still complete fully.
 */
export async function ensureHostsEntry(hostname) {
  const current = await readFile(HOSTS_PATH, 'utf8').catch(() => '');
  if (hostsHas(current, hostname)) return { ok: true, already: true };
  if (!/^[a-z0-9.-]+$/i.test(hostname)) return { ok: false, reason: `refusing to write suspicious hostname "${hostname}"` };

  await snapshotHosts().catch(() => {});
  const result = await runElevated(hostsAppendScript(hostname));
  // The elevated child's exit code flows through, but the hosts file
  // itself is the ground truth — UAC decline throws inside psCapture's
  // process and shows up as nonzero/stderr.
  const after = await readFile(HOSTS_PATH, 'utf8').catch(() => '');
  if (hostsHas(after, hostname)) {
    await flushDnsCache();
    return { ok: true, already: false };
  }
  // Only blame the UAC prompt when there is nothing better to say. Defaulting to
  // it buried the real cause whenever stderr had one, and sent users to retry an
  // elevation prompt that was never the problem.
  const stderr = (result.stderr || '').trim().split('\n')[0];
  return {
    ok: false,
    reason: stderr || `the elevation prompt was declined, or the file is read-only / locked by another program (exit ${result.code})`,
  };
}

/**
 * The lines removeHostsEntries would delete: address + ONE hostname + a
 * trailing comment that is exactly a known tool tag, loopback address only.
 * "Only ever delete a line a tool tagged" is the load-bearing rule — a
 * hand-added line, a multi-host line, or an ad-blocker's 0.0.0.0 entry
 * never matches, whatever hostname it carries. The default tag set is ours
 * alone; `includeLaragon` adds `#laragon magic!`, which only destroy asks
 * for — the operator's field test (2026-08-12) showed Laragon prunes dead
 * magic lines ONLY when a new folder appears in www, so destroying your
 * last site would otherwise leave one forever. The PowerShell filter in
 * hostsRemovalScript implements the SAME test and a parity test pins the
 * two together; see laragon.mjs's hostsContentEntryAddresses for what
 * happened last time two of these presence checks drifted.
 */
export function agentpressHostsMatches(content, hostnames, { includeLaragon = false } = {}) {
  const tags = includeLaragon ? ['agentpress', 'laragon magic!'] : ['agentpress'];
  const wanted = new Set(hostnames.map((h) => String(h).toLowerCase()));
  const matches = [];
  for (const line of String(content).split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const hashAt = text.indexOf('#');
    if (hashAt === -1) continue;
    if (!tags.includes(text.slice(hashAt + 1).trim().toLowerCase())) continue;
    const fields = text.slice(0, hashAt).trim().toLowerCase().split(/\s+/);
    if (fields.length !== 2) continue;
    if (fields[0] !== '127.0.0.1' && fields[0] !== '::1') continue;
    if (wanted.has(fields[1])) matches.push(line);
  }
  return matches;
}

/**
 * The elevated removal script. On 2026-08-12 the first version of this
 * feature left the machine's hosts file EMPTY — all ~90 entries gone — after
 * passing every offline check. The mechanism (established afterwards): its
 * `Get-Content -ErrorAction SilentlyContinue` returns NOTHING when the read
 * fails, the filter loop over zero lines produced an empty $kept, and
 * Set-Content wrote that emptiness without complaint. The read had every
 * chance to fail: destroy had just deleted a www folder, which is exactly
 * when Laragon — which rewrites the ENTIRE hosts file from a temp copy on
 * every sync — may be mid-rewrite of the same file. Laragon can do the
 * rewrite safely because it is one process that never persists a failed
 * read; v1 was two processes and did.
 *
 * Every guard below closes a piece of that hole, in order:
 *   - reads via .NET ReadAllBytes, which THROWS on a locked file instead of
 *     returning empty; retried briefly, then exit 11 with nothing written
 *   - the bytes are decoded with a STRICT UTF-8 decoder; invalid bytes are
 *     exit 19, not a rewrite. The default lenient decode turned an ANSI
 *     "café" comment into U+FFFD mojibake that a successful run then
 *     persisted file-wide — proven live under 5.1, invisible to the verify
 *     because both sides of the compare held the same replacement char.
 *   - an empty read is exit 12, never an empty write
 *   - only lines matching agentpressHostsMatches (a known tool tag, a
 *     loopback address, one hostname) are dropped, plus one blank line
 *     each — the blank the old unconditional "`r`n" append prefix left
 *     above every entry. An untagged, hand-written line never matches.
 *   - removing more than $maxRemove lines (caller-computed from a fresh
 *     count) or leaving the file empty aborts as exit 13
 *   - the new content goes to a sibling temp file, is read back and
 *     compared, and only then replaces hosts via File.Replace — NEVER
 *     Move-Item -Force, which on PowerShell 5.1 deletes the destination
 *     FIRST and renames second (proven live: a held source handle left the
 *     machine with NO hosts file, reported as "nothing was changed").
 *     File.Replace is atomic on NTFS and keeps the destination on failure;
 *     if the "impossible" still happens and hosts is missing after a failed
 *     swap, the temp file (the only good copy at that moment) is moved in,
 *     then the verified backup — the temp file is never deleted while
 *     hosts does not exist.
 *   - after the swap the file is read AGAIN; only byte-equality is exit 0.
 *     If it reads back EMPTY it is restored from the caller's verified
 *     backup (exit 16; restore failure 17). Any other difference means
 *     someone else wrote concurrently — theirs is fresher, so it is LEFT
 *     ALONE and reported as exit 18, never "restored" over.
 */
export function hostsRemovalScript(hostnames, { hostsPath = null, backupPath = null, maxRemove, includeLaragon = false }) {
  const names = hostnames.map((h) => String(h).toLowerCase());
  for (const name of names) assertScriptSafeHostname(name);
  const tagTest = includeLaragon
    ? "($comment -eq 'agentpress' -or $comment -eq 'laragon magic!')"
    : "($comment -eq 'agentpress')";
  return [
    "$ErrorActionPreference = 'Stop'",
    `$hosts = ${hostsPathExpr(hostsPath)}`,
    `$backup = ${backupPath ? psQuote(backupPath) : "''"}`,
    `$names = @(${names.map((n) => `'${n}'`).join(',')})`,
    `$maxRemove = ${Number(maxRemove)}`,
    '$bytes = $null',
    'for ($i = 0; $i -lt 8; $i++) {',
    '  try { $bytes = [System.IO.File]::ReadAllBytes($hosts); break } catch { Start-Sleep -Milliseconds 250 }',
    '}',
    'if ($null -eq $bytes) { exit 11 }',
    '$strict = New-Object System.Text.UTF8Encoding($false, $true)',
    '$raw = $null',
    'try { $raw = $strict.GetString($bytes) } catch { exit 19 }',
    'if ($raw.Trim().Length -eq 0) { exit 12 }',
    '$kept = New-Object System.Collections.Generic.List[string]',
    '$removed = 0',
    'foreach ($line in @($raw -split "\\r?\\n")) {',
    '  $text = $line.Trim()',
    '  $ours = $false',
    "  if ($text -ne '' -and -not $text.StartsWith('#') -and $text.Contains('#')) {",
    "    $parts = $text -split '#', 2",
    '    $comment = $parts[1].Trim().ToLower()',
    "    $fields = @($parts[0].Trim().ToLower() -split '\\s+' | Where-Object { $_ -ne '' })",
    `    if (${tagTest} -and $fields.Count -eq 2 -and ($fields[0] -eq '127.0.0.1' -or $fields[0] -eq '::1') -and ($names -contains $fields[1])) { $ours = $true }`,
    '  }',
    '  if ($ours) {',
    '    $removed += 1',
    "    if ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq '') { $kept.RemoveAt($kept.Count - 1); $removed += 1 }",
    '    continue',
    '  }',
    '  $kept.Add($line)',
    '}',
    'if ($removed -eq 0) { exit 10 }',
    'if ($removed -gt $maxRemove) { exit 13 }',
    '$newText = $kept -join "`r`n"',
    'if ($newText.Trim().Length -eq 0) { exit 13 }',
    '$enc = New-Object System.Text.UTF8Encoding($false)',
    "$tmp = $hosts + '.agentpress-new'",
    'try {',
    '  [System.IO.File]::WriteAllText($tmp, $newText, $enc)',
    "  if ($strict.GetString([System.IO.File]::ReadAllBytes($tmp)) -ne $newText) { throw 'staged copy did not verify' }",
    '} catch {',
    '  try { Remove-Item -Path $tmp -Force } catch {}',
    '  exit 14',
    '}',
    // A REAL backup filename for File.Replace, never $null: PowerShell binds
    // $null to a .NET string parameter as "", and Replace('' ) throws "The
    // path is not of a legal form" — every swap would exit 15. The name also
    // buys something: ReplaceFile RENAMES the old hosts to it (no delete
    // window at all), leaving the freshest possible rollback copy, which the
    // recovery paths below prefer over the caller's earlier backup.
    "$prev = $hosts + '.agentpress-prev'",
    '$swapped = $false',
    'try { [System.IO.File]::Replace($tmp, $hosts, $prev); $swapped = $true } catch {}',
    'if (-not $swapped) {',
    '  if (Test-Path -LiteralPath $hosts) {',
    '    try { Remove-Item -Path $tmp -Force } catch {}',
    '    exit 15',
    '  }',
    '  $landed = $false',
    '  try { Move-Item -Path $tmp -Destination $hosts -Force; $landed = $true } catch {}',
    '  if (-not $landed) {',
    "    $src = ''",
    '    if (Test-Path -LiteralPath $prev) { $src = $prev } elseif ($backup -ne \'\') { $src = $backup }',
    "    if ($src -eq '') { exit 17 }",
    '    try { Copy-Item -Path $src -Destination $hosts -Force } catch { exit 17 }',
    '    exit 16',
    '  }',
    '}',
    '$final = $null',
    'try { $final = $strict.GetString([System.IO.File]::ReadAllBytes($hosts)) } catch {}',
    'if ($final -eq $newText) { try { Remove-Item -Path $prev -Force } catch {}; exit 0 }',
    'if ($null -eq $final -or $final.Trim().Length -eq 0) {',
    "  $src = ''",
    '  if (Test-Path -LiteralPath $prev) { $src = $prev } elseif ($backup -ne \'\') { $src = $backup }',
    "  if ($src -eq '') { exit 17 }",
    '  try { Copy-Item -Path $src -Destination $hosts -Force; exit 16 } catch { exit 17 }',
    '}',
    'exit 18',
  ].join('\r\n');
}

/** What each non-zero verdict from the elevated script means for the user. 0 and 10 are the ok paths and handled separately. */
function removalFailureText(code, backupPath) {
  const map = {
    11: 'the hosts file could not be read (locked by another program) — nothing was changed',
    12: 'the hosts file read back empty — refusing to touch it',
    13: 'the rewrite would have removed more lines than expected — nothing was changed',
    14: 'the staged copy did not verify — nothing was changed',
    15: 'the rewritten file could not be swapped in (hosts locked by another program?) — the hosts file is unchanged',
    16: `the swap could not complete, so hosts was RESTORED from ${backupPath} — no entries were removed`,
    17: `the swap failed AND the restore failed — check the hosts file NOW; backup: ${backupPath}`,
    18: 'another program rewrote hosts at the same moment — left as it was; check it by hand',
    19: 'the hosts file contains bytes that are not valid UTF-8 text — refusing to rewrite it; remove the line by hand',
  };
  return map[code] || null;
}

/**
 * Removes tool-tagged hosts lines for these hostnames, nothing else. Never
 * fatal: every failure path leaves the file as it was (or restored) and
 * returns ok:false with the reason, so callers print the line for the user
 * instead. By default only our own `#agentpress` lines are in scope;
 * destroy passes `includeLaragon` to take the site's `#laragon magic!`
 * line with it. That opt-in exists because of a field-verified gap
 * (2026-08-12): Laragon prunes its dead magic lines only when a NEW folder
 * appears in www — a service Stop All → Start All does not rescan — so
 * destroying the last site would strand its line forever. A hostname the
 * user mapped by hand (untagged) is never touched; `remaining` reports
 * whatever still resolves it.
 */
export async function removeHostsEntries(hostnames, { includeLaragon = false } = {}) {
  const names = hostnames.map((h) => String(h).toLowerCase());
  for (const name of names) {
    if (!/^[a-z0-9.-]+$/.test(name)) return { ok: false, removed: 0, remaining: [], reason: `refusing suspicious hostname "${name}"`, backupPath: null };
  }
  let current;
  try {
    current = await readFile(HOSTS_PATH, 'utf8');
  } catch (err) {
    return { ok: false, removed: 0, remaining: [], reason: `could not read the hosts file (${err.code || err.message})`, backupPath: null };
  }
  const remainingIn = (content) => names.filter((n) => hostsContentEntryAddresses(content, n).length > 0);
  const matches = agentpressHostsMatches(current, names, { includeLaragon });
  if (matches.length === 0) {
    return { ok: true, removed: 0, remaining: remainingIn(current), reason: null, backupPath: null };
  }

  // The backup is taken BEFORE elevation and verified byte-identical — the
  // incident's recovery came from exactly such a snapshot, minutes old. An
  // unverifiable backup aborts the whole operation.
  let backupPath;
  try {
    backupPath = await snapshotHosts();
    if ((await readFile(backupPath, 'utf8')) !== current) throw new Error('backup did not read back identical');
  } catch (err) {
    return { ok: false, removed: 0, remaining: remainingIn(current), reason: `could not take a verified hosts backup first (${err.message}) — not touching the file`, backupPath: null };
  }

  // maxRemove: each matched entry plus at most one blank line above it. A
  // concurrent change that makes the filter want more than this fresh count
  // allows aborts inside the script.
  const script = hostsRemovalScript(names, { backupPath, maxRemove: matches.length * 2, includeLaragon });
  const result = await runElevated(script);
  const after = await readFile(HOSTS_PATH, 'utf8').catch(() => null);

  if (result.code === 0 || result.code === 10) {
    // Ground truth over exit code, same policy as ensureHostsEntry.
    if (after !== null && agentpressHostsMatches(after, names, { includeLaragon }).length === 0) {
      await flushDnsCache();
      return { ok: true, removed: result.code === 0 ? matches.length : 0, remaining: remainingIn(after), reason: null, backupPath };
    }
    return { ok: false, removed: 0, remaining: after === null ? names : remainingIn(after), reason: 'the elevated run reported success but the tagged lines are still present — leaving everything alone', backupPath };
  }
  const stderr = (result.stderr || '').trim().split('\n')[0];
  return {
    ok: false,
    removed: 0,
    remaining: after === null ? names : remainingIn(after),
    reason: removalFailureText(result.code, backupPath) || stderr || `the elevation prompt was declined, or the elevated run failed (exit ${result.code})`,
    backupPath,
  };
}

/**
 * Windows caches NEGATIVE lookups: anything that resolved the new hostname
 * before its hosts line landed poisons every later process with ENOTFOUND
 * (bit this project four times: browsers after restarts, and an MCP proxy
 * that reported a healthy site as unreachable). Flush right after any hosts
 * change; works unelevated and is instant. Best-effort — a failure just
 * means the user may need one manual `ipconfig /flushdns`.
 */
export async function flushDnsCache() {
  const { spawn } = await import('node:child_process');
  await new Promise((resolve) => {
    let child;
    try {
      child = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ipconfig.exe'), ['/flushdns'], {
        stdio: 'ignore',
        shell: false,
      });
    } catch {
      resolve();
      return;
    }
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}
