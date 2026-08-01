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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HOSTS_PATH, SITES_ENABLED_APACHE, WWW_DIR } from './paths.mjs';
import { psCapture } from './win.mjs';
import { inferHostnameSuffix, snapshotHosts } from './laragon.mjs';

export const WILDCARD_CONF_PATH = join(SITES_ENABLED_APACHE, 'zzz-katalyst-wildcard.conf');

export function wildcardConfInstalled() {
  return existsSync(WILDCARD_CONF_PATH);
}

export async function installWildcardConf() {
  const { suffix } = await inferHostnameSuffix();
  const www = WWW_DIR.replace(/\\/g, '/');
  const conf = `# katalyst-laragon "instant mode" wildcard vhost — managed by create-katalyst-laragon.
# Maps every <name>${suffix} to ${www}/<name>/public with no per-site vhost and no
# Laragon reload. The zzz- filename keeps this LAST in Apache's first-match vhost
# order, so exact-name confs for existing sites always win. Delete this file (and
# restart Apache) to disable.
<IfModule !vhost_alias_module>
    LoadModule vhost_alias_module modules/mod_vhost_alias.so
</IfModule>
<VirtualHost *:80>
    ServerName katalyst-wildcard${suffix}
    ServerAlias *${suffix}
    UseCanonicalName Off
    VirtualDocumentRoot "${www}/%1/public"
</VirtualHost>
# .htaccess support for wildcard-served sites — scoped to */public trees only
# (Laragon's global www grant is AllowOverride None; its per-site confs add All
# per root, which the wildcard can't do per site).
<Directory "${www}/*/public">
    AllowOverride All
    Require all granted
</Directory>
`;
  await writeFile(WILDCARD_CONF_PATH, conf, 'utf8');
  return { suffix, path: WILDCARD_CONF_PATH };
}

/**
 * HTTP over the loopback with an explicit Host header — DNS never enters
 * the picture, which both makes probes hosts-entry-independent and dodges
 * the Windows DNS-cache staleness that can make a fresh hostname
 * unresolvable right after a restart.
 */
export function fetchViaLoopback(hostname, path, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: 80, path, headers: { Host: hostname }, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
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
export async function wildcardActive() {
  if (!wildcardConfInstalled()) return false;
  const { suffix } = await inferHostnameSuffix();
  const name = `kat-probe-${randomBytes(4).toString('hex')}`;
  const token = randomBytes(12).toString('hex');
  const dir = join(WWW_DIR, name, 'public');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'katalyst-probe.txt'), token, 'utf8');
    const res = await fetchViaLoopback(`${name}${suffix}`, '/katalyst-probe.txt');
    return Boolean(res && res.status === 200 && res.body.trim() === token);
  } catch {
    return false;
  } finally {
    await rm(join(WWW_DIR, name), { recursive: true, force: true }).catch(() => {});
  }
}

function hostsHas(content, hostname) {
  const needle = hostname.toLowerCase();
  return content
    .split('\n')
    .some((line) => !line.trim().startsWith('#') && line.toLowerCase().split(/\s+/).includes(needle));
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
  const script = [
    "$hosts = Join-Path $env:SystemRoot 'System32\\drivers\\etc\\hosts'",
    `$name = '${hostname}'`,
    '$content = Get-Content -Path $hosts -Raw -ErrorAction SilentlyContinue',
    'if ($content -notmatch [regex]::Escape($name)) {',
    "  Add-Content -Path $hosts -Value (\"`r`n127.0.0.1`t\" + $name + \"`t#katalyst-laragon\") -NoNewline:$false",
    '}',
    'exit 0',
  ].join('\r\n');
  const tmp = join(tmpdir(), `katalyst-hosts-${randomBytes(6).toString('hex')}.ps1`);
  await writeFile(tmp, script, 'utf8');
  try {
    const result = await psCapture(
      `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${tmp}'; exit $p.ExitCode`,
    );
    // The elevated child's exit code flows through, but the hosts file
    // itself is the ground truth — UAC decline throws inside psCapture's
    // process and shows up as nonzero/stderr.
    const after = await readFile(HOSTS_PATH, 'utf8').catch(() => '');
    if (hostsHas(after, hostname)) return { ok: true, already: false };
    return { ok: false, reason: (result.stderr || 'the elevation prompt was declined or the write failed').trim().split('\n')[0] };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}
