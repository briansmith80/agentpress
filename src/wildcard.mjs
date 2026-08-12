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

/**
 * Removes this site's hosts line, the mirror of ensureHostsEntry and by the same
 * elevated route. `destroy` used to state that it never touches hosts and print the
 * line for you to delete by hand, which was doubly wrong: this tool DOES write hosts
 * (below), and leaving the line behind means a destroyed hostname keeps resolving to
 * 127.0.0.1 until Laragon happens to prune it.
 *
 * The match is deliberately narrow. A line is removed only when its non-comment
 * tokens are exactly [address, this-hostname] — so a line naming several hosts, or
 * naming a different host, cannot be touched no matter what tag it carries. Same
 * reasoning as revokeAppPasswords never using `--all`: on a long-lived machine this
 * file holds entries the user wrote by hand and they are not ours to tidy.
 *
 * Never fatal. A declined UAC prompt returns ok:false and the caller prints the line,
 * which is exactly the old behaviour.
 */
export async function removeHostsEntry(hostname) {
  if (!/^[a-z0-9.-]+$/i.test(hostname)) return { ok: false, reason: `refusing to act on suspicious hostname "${hostname}"` };
  const current = await readFile(HOSTS_PATH, 'utf8').catch(() => '');
  if (!hostsHas(current, hostname)) return { ok: true, already: true };

  await snapshotHosts().catch(() => {});
  return runElevatedHostsScript(hostsRemovalScript(hostname), hostname);
}

/**
 * The elevated removal script, as a pure function of the hostname, so the SHIPPED text
 * can be exercised against a temp file rather than a copy of it being tested.
 * `hostsExpr` is the PowerShell expression for the file to edit; a test passes
 * `$args[0]`.
 *
 * Token-exact and count-exact, mirroring hostsHas. A substring test here would be the
 * same bug ensureHostsEntry's comment records: "blog" matching "myblog.test".
 *
 * Verified against a fake hosts file covering every shape that matters: it removes
 * `127.0.0.1 host #agentpress`, `127.0.0.1 host #laragon magic!`, `::1 host` and
 * `127.0.0.1 HOST`, while keeping comments, blank lines, a different host, a SHARED
 * line naming two hosts, a commented-out mention, and both substring traps
 * (`nothost.test`, `host.test.uk`).
 */
export function hostsRemovalScript(hostname, hostsExpr = "Join-Path $env:SystemRoot 'System32\\drivers\\etc\\hosts'") {
  return [
    `$hosts = ${hostsExpr}`,
    `$name = '${hostname}'.ToLower()`,
    // -ErrorAction Stop, NEVER SilentlyContinue. This script REWRITES the file from
    // what it read, so a silently-swallowed read failure (the file locked by another
    // process) would leave $kept empty and Set-Content would blank the machine's hosts
    // file. Fail loudly and touch nothing instead.
    '$all = @(Get-Content -Path $hosts -ErrorAction Stop)',
    'if ($all.Count -eq 0) { exit 3 }',
    '$kept = New-Object System.Collections.Generic.List[string]',
    'foreach ($line in $all) {',
    '  $text = $line.Trim()',
    "  if ($text -eq '' -or $text.StartsWith('#')) { $kept.Add($line); continue }",
    "  $tokens = @(($text -split '#')[0].ToLower() -split '\\s+' | Where-Object { $_ -ne '' })",
    // Exactly two tokens, the second being ours: an address and this hostname alone.
    '  if ($tokens.Count -eq 2 -and $tokens[1] -eq $name) { continue }',
    '  $kept.Add($line)',
    '}',
    // Nothing matched: do not rewrite a system file for no reason.
    'if ($kept.Count -eq $all.Count) { exit 0 }',
    // Belt and braces against ever truncating it to nothing.
    'if ($kept.Count -eq 0) { exit 4 }',
    'Set-Content -Path $hosts -Value $kept -Encoding ASCII',
    'exit 0',
  ].join('\r\n');
}

async function runElevatedHostsScript(script, hostname) {
  const tmp = join(tmpdir(), `agentpress-hosts-rm-${randomBytes(6).toString('hex')}.ps1`);
  await writeFile(tmp, script, 'utf8');
  try {
    const result = await psCapture(
      `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(tmp)}; exit $p.ExitCode`,
    );
    // The file is the ground truth, not the child's exit code — same stance as the
    // write path, because a declined prompt surfaces inconsistently.
    const after = await readFile(HOSTS_PATH, 'utf8').catch(() => '');
    if (!hostsHas(after, hostname)) {
      await flushDnsCache();
      return { ok: true, already: false };
    }
    const stderr = (result.stderr || '').trim().split('\n')[0];
    return { ok: false, reason: stderr || `the elevation prompt was declined, or the file is read-only / locked (exit ${result.code})` };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
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
  // The presence re-check inside the elevated script must be TOKEN-EXACT, the
  // same test hostsHas() does. It used to be `-notmatch [regex]::Escape($name)`,
  // a substring match: with myblog.test already in hosts, scaffolding "blog"
  // found "blog.test" inside "myblog.test", skipped the write, and the caller —
  // which re-reads hosts and correctly finds no entry — then reported "the
  // elevation prompt was declined", which was false and no retry could fix.
  const script = [
    "$hosts = Join-Path $env:SystemRoot 'System32\\drivers\\etc\\hosts'",
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
    "  Add-Content -Path $hosts -Value (\"`r`n127.0.0.1`t\" + $name + \"`t#agentpress\") -NoNewline:$false",
    '}',
    'exit 0',
  ].join('\r\n');
  const tmp = join(tmpdir(), `agentpress-hosts-${randomBytes(6).toString('hex')}.ps1`);
  await writeFile(tmp, script, 'utf8');
  try {
    // psQuote, not a bare '${tmp}'. %TEMP% contains the Windows account name, so an
    // apostrophe in it ("O'Brien") closed the PowerShell string early and broke the
    // hosts write permanently for that user — reported to them, wrongly, as "the
    // elevation prompt was declined", which no retry could fix.
    const result = await psCapture(
      `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(tmp)}; exit $p.ExitCode`,
    );
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
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
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
