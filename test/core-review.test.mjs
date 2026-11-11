// The security review of the core (2026-11-11), kept as tests: destroy acting
// on another site's .env, the elevated hosts script sitting in a folder
// anything can write, the loopback guard seeing a tunnel as local, and three
// small ones (PowerShell's curly quotes, a version string, the guard asked
// for directly).
//
// PowerShell tests run on CI too (windows-latest has it). The PHP test skips
// only when PHP is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { psCapture, psQuote } from '../src/win.mjs';
import { destroyTargetProblems } from '../src/destroy.mjs';
import { elevatedLauncherScript, isLocalDevHostname } from '../src/wildcard.mjs';
import { MCP_GUARD_PHP } from '../src/wordpress.mjs';
import { runPhpCode } from '../src/wp.mjs';

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/* ------------------------------------------------------------ destroy -- */

test('destroy refuses a folder whose .env describes some other site', () => {
  const dir = 'C:\\laragon\\www\\shop';
  const ok = { DB_NAME: 'shop', DB_USER: 'shop', DB_HOST: '127.0.0.1', SITE_HOST: 'shop.test' };
  assert.deepEqual(destroyTargetProblems({ projectDir: dir, env: ok }), []);
  assert.deepEqual(destroyTargetProblems({ projectDir: dir, env: { ...ok, DB_HOST: '127.0.0.1:3307' } }), []);
  assert.deepEqual(destroyTargetProblems({ projectDir: dir, env: { ...ok, DB_HOST: 'localhost' } }), []);
  assert.deepEqual(destroyTargetProblems({ projectDir: dir, env: { ...ok, DB_HOST: undefined } }), [], 'no DB_HOST means the default, which is local');
  assert.deepEqual(destroyTargetProblems({ projectDir: 'C:\\laragon\\www\\Shop', env: ok }), [], 'folder case does not matter on Windows');

  // The case this exists for: a copy of the site, run from inside the copy.
  const copy = destroyTargetProblems({ projectDir: 'C:\\laragon\\www\\shop-backup', env: ok });
  assert.equal(copy.length, 1);
  assert.match(copy[0], /shop\.test/);
  assert.match(copy[0], /ORIGINAL/);
  // "shop" is not "shop-backup" by prefix either way round.
  assert.equal(destroyTargetProblems({ projectDir: dir, env: { ...ok, SITE_HOST: 'shop-backup.test' } }).length, 1);

  // A site Laragon named differently is recognised by the registry entry for this exact folder.
  assert.deepEqual(destroyTargetProblems({ projectDir: dir, env: { ...ok, SITE_HOST: 'store.test' }, registeredHostname: 'store.test' }), []);
  assert.equal(destroyTargetProblems({ projectDir: dir, env: { ...ok, SITE_HOST: 'store.test' }, registeredHostname: 'other.test' }).length, 1);

  // Root credentials are never tried against a server that is not this machine.
  for (const host of ['db.example.com', 'db.example.com:3306', '10.0.0.5', '192.168.1.20:3306', '127.0.0.1.example.com']) {
    const problems = destroyTargetProblems({ projectDir: dir, env: { ...ok, DB_HOST: host } });
    assert.equal(problems.length, 1, host);
    assert.match(problems[0], /not this machine/);
  }
});

test('destroy makes the check itself, and the command makes it before the preamble', async () => {
  const lib = (await readFile(new URL('../src/destroy.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const site = lib.slice(lib.indexOf('export async function destroySite('));
  assert.ok(site.indexOf('destroyTargetProblems(') > 0 && site.indexOf('destroyTargetProblems(') < site.indexOf('removeMcpEntries('), 'before the first thing it removes');
  const cmd = (await readFile(new URL('../src/engine.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const body = cmd.slice(cmd.indexOf('async function destroyCommand('));
  assert.ok(body.indexOf('destroyTargetProblems(') < body.indexOf('if (!yes) {'), '--yes does not skip it');
});

/* -------------------------------------------------------------- hosts -- */

test('only a local development name is ever pointed at this machine', () => {
  for (const host of ['shop.test', 'my-site.test', 'a.b.test', 'shop.localhost']) assert.equal(isLocalDevHostname(host), true, host);
  assert.equal(isLocalDevHostname('shop.dev', '.dev'), true, "Laragon's own suffix counts");
  for (const host of ['github.com', 'test', '.test', 'shop.test.example.com', 'shop.testing', 'registry.npmjs.org', 'shop.test ', 'a b.test', '']) {
    assert.equal(isLocalDevHostname(host), false, JSON.stringify(host));
  }
  assert.equal(isLocalDevHostname('github.com', 'not a suffix'), false);
});

test('the wrapper runs the script it was given, locked, and refuses one that changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentpress-launch-'));
  try {
    const marker = join(dir, 'ran.txt');
    const script = join(dir, 'script.ps1');
    // The stand-in script tries to open ITSELF for writing, which is what a
    // program swapping the file would have to do. 7 = it could not.
    const body = [
      `Set-Content -Path ${psQuote(marker)} -Value 'ran'`,
      'try { [System.IO.File]::Open($PSCommandPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite).Close(); exit 5 } catch { exit 7 }',
    ].join('\r\n');
    await writeFile(script, body, 'utf8');

    const wrong = await psCapture(elevatedLauncherScript(script, sha256(`${body}\r\n# swapped`), { elevate: false }));
    assert.equal(wrong.code, 97, wrong.stderr);
    assert.equal(existsSync(marker), false, 'a script that does not match is never started');

    const right = await psCapture(elevatedLauncherScript(script, sha256(body), { elevate: false }));
    assert.equal(right.code, 7, `the script ran, saw its own file locked against writers, and its exit code came back (${right.stderr})`);
    assert.equal(existsSync(marker), true);

    // Free again once the run has ended, or the caller could not delete it.
    await rm(script);
    assert.equal(existsSync(script), false);

    const gone = await psCapture(elevatedLauncherScript(script, sha256(body), { elevate: false }));
    assert.equal(gone.code, 96);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the elevated run is asked for with the same wrapper, plus RunAs', () => {
  const digest = 'a'.repeat(64);
  const elevated = elevatedLauncherScript("C:\\Users\\O'Brien\\AppData\\Local\\Temp\\x.ps1", digest);
  const plain = elevatedLauncherScript("C:\\Users\\O'Brien\\AppData\\Local\\Temp\\x.ps1", digest, { elevate: false });
  assert.equal(elevated.replace('-Verb RunAs ', ''), plain, 'what the test above runs is what ships, minus the prompt');
  assert.match(elevated, /\$tmp = 'C:\\Users\\O''Brien\\AppData\\Local\\Temp\\x\.ps1'/);
  assert.doesNotMatch(elevated, /"/, 'no double quote has to survive the command line');
  assert.doesNotMatch(elevated, /Start-Process powershell\b/, 'PowerShell is named by its full path');
  assert.throws(() => elevatedLauncherScript('x.ps1', 'not-a-digest'));
});

/* ------------------------------------------------------ small fixes -- */

test('psQuote doubles every character PowerShell reads as a single quote', () => {
  assert.equal(psQuote("o'brien"), "'o''brien'");
  // Proven against real PowerShell the day this was written: each of these
  // came back as the same characters, as one argument.
  assert.equal(psQuote('a\u2019 + \u2018b'), "'a\u2019\u2019 + \u2018\u2018b'");
  assert.equal(psQuote('\u201Ax\u201B'), "'\u201A\u201Ax\u201B\u201B'");
  assert.equal(psQuote(''), "''");
  // Nothing else is touched: a dollar sign is literal inside single quotes.
  assert.equal(psQuote('$env:X `n "q"'), '\'$env:X `n "q"\'');
  // Between the outer pair, no quote character stands alone.
  for (const value of ["'", '\u2018\u2019', "a'\u2019'b", '\u201B']) {
    const inner = psQuote(value).slice(1, -1);
    assert.equal(inner.replace(/(['\u2018\u2019\u201A\u201B])\1/g, '').match(/['\u2018\u2019\u201A\u201B]/), null, JSON.stringify(value));
  }
});

test('doctor only repeats a registry version that is a version number', async () => {
  const src = await readFile(new URL('../src/doctor.mjs', import.meta.url), 'utf8');
  assert.match(src, /typeof data\.version === 'string' && \/\^\\d\+\\\.\\d\+\\\.\\d\+\$\/\.test\(data\.version\) \? data\.version : null/);
});

/* --------------------------------------------------- loopback guard -- */

test('the loopback guard does nothing when it is asked for directly', () => {
  const exit = MCP_GUARD_PHP.replace(/\r\n/g, '\n').indexOf("if ( ! defined( 'ABSPATH' ) ) {\n\texit;\n}");
  assert.ok(exit > 0, 'the guard checks for WordPress');
  // A call at the start of a line, not the word in a comment.
  const firstCall = MCP_GUARD_PHP.search(/^add_filter\(/m);
  assert.ok(firstCall > 0 && exit < firstCall, 'and does so before it touches WordPress');
});

test('the loopback guard lets the local agent in and refuses a tunnel', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agentpress-guard-'));
  try {
    const guard = join(dir, 'guard.php');
    await writeFile(guard, MCP_GUARD_PHP, 'utf8');
    // [route, $_SERVER, allowed?]
    const cases = [
      ['/mcp/mcp-adapter-default-server', { REMOTE_ADDR: '127.0.0.1' }, true],
      ['/wp-abilities/v1/abilities/x/run', { REMOTE_ADDR: '::1' }, true],
      ['/mcp/x', { REMOTE_ADDR: '::ffff:127.0.0.1' }, true],
      ['/mcp/x', { REMOTE_ADDR: '192.168.1.50' }, false],
      ['/mcp/x', {}, false],
      // A tunnel runs on this machine, so its traffic arrives from loopback.
      ['/mcp/x', { REMOTE_ADDR: '127.0.0.1', HTTP_X_FORWARDED_FOR: '203.0.113.9' }, false],
      ['/wp-abilities/v1/x', { REMOTE_ADDR: '127.0.0.1', HTTP_CF_CONNECTING_IP: '203.0.113.9' }, false],
      ['/mcp/x', { REMOTE_ADDR: '127.0.0.1', HTTP_FORWARDED: 'for=203.0.113.9' }, false],
      ['/mcp/x', { REMOTE_ADDR: '127.0.0.1', HTTP_X_FORWARDED_HOST: 'abc.ngrok-free.app' }, false],
      ['/mcp/x', { REMOTE_ADDR: '127.0.0.1', HTTP_X_REAL_IP: '203.0.113.9' }, false],
      // Claiming to be local in the header buys nothing.
      ['/mcp/x', { REMOTE_ADDR: '192.168.1.50', HTTP_X_FORWARDED_FOR: '127.0.0.1' }, false],
      ['/mcp/x', { REMOTE_ADDR: '127.0.0.1', HTTP_X_FORWARDED_FOR: '127.0.0.1' }, false],
      // An empty header is not a forwarded request.
      ['/mcp/x', { REMOTE_ADDR: '127.0.0.1', HTTP_X_FORWARDED_FOR: '' }, true],
      // Everything else on the site is none of the guard's business.
      ['/wp/v2/posts', { REMOTE_ADDR: '203.0.113.9', HTTP_X_FORWARDED_FOR: '203.0.113.9' }, true],
    ];
    const payload = Buffer.from(JSON.stringify(cases.map(([route, server]) => ({ route, server })))).toString('base64');
    const code = [
      "define('ABSPATH', '/');",
      'class WP_Error { public $code; function __construct($c = "", $m = "", $d = array()) { $this->code = $c; } }',
      'class Req { public $r; function __construct($r) { $this->r = $r; } function get_route() { return $this->r; } }',
      '$GLOBALS["cb"] = null;',
      'function add_filter($tag, $fn, $prio = 10, $n = 1) { if ($tag === "rest_pre_dispatch") { $GLOBALS["cb"] = $fn; } }',
      `require ${JSON.stringify(guard)};`,
      '$out = array();',
      `foreach (json_decode(base64_decode('${payload}'), true) as $case) {`,
      '  $_SERVER = $case["server"];',
      '  $res = call_user_func($GLOBALS["cb"], null, null, new Req($case["route"]));',
      '  $out[] = !($res instanceof WP_Error);',
      '}',
      "echo 'OUT:' . base64_encode(json_encode($out));",
    ].join(' ');
    let res;
    try {
      res = await runPhpCode(code);
    } catch {
      return t.skip('PHP unavailable here');
    }
    if (res.code === null) return t.skip('PHP unavailable here');
    const match = /OUT:([A-Za-z0-9+/=]+)/.exec(res.stdout);
    assert.ok(res.code === 0 && match, `PHP ran but the guard did not answer: ${res.stderr || res.stdout}`);
    const allowed = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    cases.forEach(([route, server, want], i) => assert.equal(allowed[i], want, `${route} ${JSON.stringify(server)}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- menu -- */

test('a result opens on a clean screen without throwing the old one away', async () => {
  const menu = (await readFile(new URL('../template/scripts/agentpress.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const fn = menu.slice(menu.indexOf('function resultScreen('), menu.indexOf('\n}\n', menu.indexOf('function resultScreen(')));
  // To the bottom row, one line feed per row, then home: the view scrolls up into the scrollback.
  assert.ok(fn.includes("process.stdout.write(`\\x1b[${rows};1H${'\\n'.repeat(rows)}\\x1b[H`)"));
  assert.match(fn, /process\.stdout\.isTTY \? process\.stdout\.rows : 0/, 'nothing is written when output is not a terminal');
  assert.ok(!menu.includes('\x1b[2J') && !menu.includes('\x1b[3J') && !menu.includes('\\x1b[2J') && !menu.includes('\\x1b[3J'), 'never an erase of the normal screen or its scrollback');
});

/* -------------------------------------------------------------- codex -- */

import { codexWordpressUrl } from '../src/destroy.mjs';

test("destroy reads Codex's target from its config, because Codex prints it as stars", async () => {
  // `codex mcp get wordpress` answers `env: … WP_API_URL=*****`. Destroy looked
  // for the hostname in that text, never found it, and left Codex wired to a
  // site that no longer existed (live scaffold-and-destroy, 2026-11-11).
  const table = ['[mcp_servers]', '', '[mcp_servers.wordpress]', 'command = "npx"', 'args = ["-y", "x"]', '', '[mcp_servers.wordpress.env]', 'OAUTH_ENABLED = "false"', 'WP_API_URL = "http://shop.test/wp-json/mcp/mcp-adapter-default-server"', 'WP_API_USERNAME = "admin"', '', '[mcp_servers.playwright]', 'command = "npx"'].join('\r\n');
  assert.equal(codexWordpressUrl(table), 'http://shop.test/wp-json/mcp/mcp-adapter-default-server');
  const inline = '[mcp_servers.wordpress]\ncommand = "npx"\nenv = { OAUTH_ENABLED = "false", WP_API_URL = "https://shop.test/x" }\n';
  assert.equal(codexWordpressUrl(inline), 'https://shop.test/x');
  assert.equal(codexWordpressUrl("[mcp_servers.wordpress.env]\nWP_API_URL = 'http://lit.test/x'\n"), 'http://lit.test/x');
  // Some other server's address is not the wordpress entry's.
  assert.equal(codexWordpressUrl('[mcp_servers.other.env]\nWP_API_URL = "http://shop.test/x"\n'), null);
  assert.equal(codexWordpressUrl('[mcp_servers.wordpress.env]\nOAUTH_ENABLED = "false"\n\n[mcp_servers.other.env]\nWP_API_URL = "http://shop.test/x"\n'), null);
  assert.equal(codexWordpressUrl(''), null);
  assert.equal(codexWordpressUrl(null), null);

  const lib = (await readFile(new URL('../src/destroy.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  // Exact host, so shop.test is never found inside myshop.test.
  assert.match(lib, /hostOf\(codexUrl\) === siteHostname\.toLowerCase\(\)/);
});
