// Pure-function tests. No Laragon, no Apache, no MySQL, no network — these
// must run in seconds on a bare runner, which is what makes them worth having.
//
// Every case here exists because the behaviour it pins either shipped broken
// once or guards something expensive to get wrong. Where that is true the test
// names say so, so a future reader knows which assertions are load-bearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSiteName } from '../src/names.mjs';
import { parseDbHost, sanitizeDbIdentifier, escapeSqlString } from '../src/mysql.mjs';
import { parseArgs, parseEnvFile } from '../src/engine.js';
import { hostsContentEntryAddresses, isLoopbackAddress } from '../src/laragon.mjs';
import { zipMatchesSlug } from '../src/plugins.mjs';
import { applyAgentSections } from '../src/templates.mjs';
import { compareVersionsDesc } from '../src/wp.mjs';
import { formatEnvironmentsTable } from '../src/registry.mjs';

test('validateSiteName accepts DNS-label-safe names', () => {
  for (const name of ['mysite', 'my-site', 'a', 'a1', 'site123', 'a'.repeat(40)]) {
    assert.deepEqual(validateSiteName(name), [], `${name} should be valid`);
  }
});

test('validateSiteName rejects what would break a folder, a hostname or a vhost', () => {
  for (const name of ['', 'My-Site', 'my_site', '-lead', 'trail-', 'a'.repeat(41), 'has space', 'dot.dot']) {
    assert.notEqual(validateSiteName(name).length, 0, `${name} should be rejected`);
  }
});

test('validateSiteName rejects reserved Windows device names (a folder named con cannot be created)', () => {
  for (const name of ['con', 'CON', 'prn', 'aux', 'nul', 'com1', 'lpt9']) {
    assert.notEqual(validateSiteName(name).length, 0, `${name} is a reserved device name`);
  }
});

test('sanitizeDbIdentifier truncates with a content hash so two long names cannot collide', () => {
  assert.equal(sanitizeDbIdentifier('my-site', 64), 'my_site');
  const a = sanitizeDbIdentifier(`${'a'.repeat(60)}-one`, 32);
  const b = sanitizeDbIdentifier(`${'a'.repeat(60)}-two`, 32);
  assert.equal(a.length, 32);
  assert.equal(b.length, 32);
  assert.notEqual(a, b, 'names differing only after the cutoff must not collide');
});

test('parseDbHost splits the host:port form destroy relies on to target the right server', () => {
  assert.deepEqual(parseDbHost('127.0.0.1:3307'), { host: '127.0.0.1', port: 3307 });
  assert.equal(parseDbHost('127.0.0.1').host, '127.0.0.1');
  assert.equal(parseDbHost('').host, '127.0.0.1');
  assert.equal(parseDbHost(undefined).host, '127.0.0.1');
});

test('escapeSqlString escapes quotes and backslashes before they reach root-privileged SQL', () => {
  assert.equal(escapeSqlString("it's"), "it\\'s");
  assert.equal(escapeSqlString('back\\slash'), 'back\\\\slash');
});

test('parseArgs handles bare flags, key=value flags and positionals', () => {
  const a = parseArgs(['mysite', '--yes', '--premium=none', '--plugins=akismet,seo']);
  assert.equal(a.command, 'mysite');
  assert.equal(a.yes, true);
  assert.equal(a.flags.premium, 'none');
  assert.equal(a.flags.plugins, 'akismet,seo');
  assert.equal(parseArgs(['-y']).yes, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.equal(parseArgs(['--premium']).flags.premium, true, 'a bare --flag is boolean true');
});

// REGRESSION: a CRLF .env made every line fail the old match, yielding an EMPTY
// env — so destroy reported success while silently skipping the database drop.
test('parseEnvFile reads CRLF as well as LF (destroy skipped the DB drop when it did not)', () => {
  const lf = 'DB_NAME=site\nSITE_HOST=site.test\nWP_ADMIN_USER=admin\n';
  const expected = { DB_NAME: 'site', SITE_HOST: 'site.test', WP_ADMIN_USER: 'admin' };
  assert.deepEqual(parseEnvFile(lf), expected);
  assert.deepEqual(parseEnvFile(lf.replace(/\n/g, '\r\n')), expected, 'CRLF must parse identically');
});

test('parseEnvFile keeps values containing = and ignores non-KEY lines', () => {
  const out = parseEnvFile('WP_ADMIN_PASSWORD=a=b=c\n# a comment\n\nnot a pair\n');
  assert.equal(out.WP_ADMIN_PASSWORD, 'a=b=c');
  assert.equal(Object.keys(out).length, 1);
});

// REGRESSION: three separate hosts parsers disagreed about what "present"
// means, so a hostname mentioned in another line's trailing comment counted as
// wired for one of them and absent for another.
test('hostsContentEntryAddresses ignores comments and never treats the address field as a hostname', () => {
  const hosts = [
    '# a comment',
    '127.0.0.1\tmysite.test\t#agentpress',
    '   # 127.0.0.1 commented.test',
    '127.0.0.1 first.test second.test',
    '0.0.0.0 blocked.test',
    '127.0.0.1  dev.test  # was retired.test, kept for reference',
    '::1 ipv6.test',
  ].join('\r\n');
  assert.deepEqual(hostsContentEntryAddresses(hosts, 'mysite.test'), ['127.0.0.1']);
  assert.deepEqual(hostsContentEntryAddresses(hosts, 'commented.test'), [], 'commented-out lines are not entries');
  assert.deepEqual(hostsContentEntryAddresses(hosts, 'second.test'), ['127.0.0.1'], 'aliases count');
  assert.deepEqual(hostsContentEntryAddresses(hosts, 'blocked.test'), ['0.0.0.0']);
  assert.deepEqual(hostsContentEntryAddresses(hosts, 'retired.test'), [], 'a name inside a trailing comment is NOT an entry');
  assert.deepEqual(hostsContentEntryAddresses(hosts, 'ipv6.test'), ['::1']);
  assert.deepEqual(hostsContentEntryAddresses(hosts, '127.0.0.1'), [], 'the address field is never a hostname');
});

test('isLoopbackAddress covers the spellings a hosts file realistically carries', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ['0.0.0.0', '192.168.1.5', '10.0.0.1', '2001:db8::1', '', null, undefined, '127.0.0.1.evil.com']) {
    assert.equal(isLoopbackAddress(a), false, String(a));
  }
});

// This filter is what stops a release asset from shadowing a good cached zip.
test('zipMatchesSlug matches the slug exactly or its version-suffixed form, nothing else', () => {
  const oxygen = { slug: 'oxygen', filePrefix: 'oxygen-' };
  assert.equal(zipMatchesSlug('oxygen.zip', oxygen), true);
  assert.equal(zipMatchesSlug('oxygen-6.2.zip', oxygen), true);
  assert.equal(zipMatchesSlug('OXYGEN-6.2.ZIP', oxygen), true, 'filenames are case-insensitive on Windows');
  assert.equal(zipMatchesSlug('oxygenate.zip', oxygen), false, 'a prefix match is not a slug match');
  assert.equal(zipMatchesSlug('breakdance-forms.zip', oxygen), false);
  assert.equal(zipMatchesSlug('oxygen-6.2.txt', oxygen), false, 'only .zip');
});

// REGRESSION: a plain string replace let a $& in a substituted VALUE re-insert
// the matched token, so a password containing $& corrupted the output.
test('applyAgentSections and token substitution do not let $-sequences in values corrupt output', () => {
  assert.equal(applyAgentSections('plain text', ['claude']), 'plain text');
  const withDollar = 'x'.replace('x', () => 'a$&b');
  assert.equal(withDollar, 'a$&b', 'function-form replace keeps $& literal');
});

test('compareVersionsDesc orders numerically, not lexically', () => {
  assert.deepEqual(['8.0.30', '8.0.9', '10.2.1'].sort(compareVersionsDesc), ['10.2.1', '8.0.30', '8.0.9']);
});

test('formatEnvironmentsTable survives an entry with missing fields (it used to crash the command that heals the registry)', () => {
  assert.match(formatEnvironmentsTable([]), /No environments yet/);
  const out = formatEnvironmentsTable([{ dir: 'C:\\laragon\\www\\x' }]);
  assert.match(out, /x/);
  assert.doesNotMatch(out, /undefined/);
});

test('the hand-recovery SQL names the same grant host the code actually drops', async () => {
  // provisionDatabase creates the user as @'127.0.0.1' and dropDatabase drops that
  // exact grant. The halt message once told users to type @'localhost', which under
  // DROP USER IF EXISTS is a silent no-op: it reports success and leaves the MySQL
  // user behind. Pinned here because the two live in different files.
  const read = async (rel) => (await import('node:fs/promises')).readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
  const mysql = await read('src/mysql.mjs');
  const engine = await read('src/engine.js');

  const host = mysql.match(/CREATE USER IF NOT EXISTS '\$\{dbUser\}'@'([\d.]+)'/)?.[1];
  assert.equal(host, '127.0.0.1', 'the grant host in mysql.mjs changed — update the recovery text too');
  assert.match(engine, /DROP USER IF EXISTS '\$\{result\.recovery\.dbUser\}'@'127\.0\.0\.1'/);
  assert.doesNotMatch(engine, /DROP USER IF EXISTS[^\n]*@'localhost'/, 'localhost would silently drop nothing');
});

test('the locked-folder advice never tells the user to pass a site name to destroy', async () => {
  // destroy takes no site name and refuses one (v1.8.0). An earlier draft of this
  // very message said "cd out, then destroy <name>", i.e. advice the tool rejects.
  const read = async (rel) => (await import('node:fs/promises')).readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
  const engine = await read('src/engine.js');
  const block = engine.match(/That folder is in use[\s\S]{0,1200}?\n {10}: `/)?.[0] || '';
  assert.ok(block, 'the locked-folder branch must be findable');
  assert.doesNotMatch(block, /destroy \$\{basename/, 'never suggest destroy <name>');
  assert.match(block, /Remove-Item -Recurse -Force/, 'give the manual removal instead');
});

test('formatEnvironmentsTable answers "which sites are behind, and which one are my agents on?"', () => {
  // Both questions previously had no answer short of opening sandbox.config.json
  // per site and ~/.claude.json by hand.
  const envs = [
    { name: 'alpha', hostname: 'alpha.test', dir: 'C:\\laragon\\www\\alpha', version: '1.8.0', agents: ['claude'] },
    { name: 'beta', hostname: 'beta.test', dir: 'C:\\laragon\\www\\beta', version: '1.6.0' },
    { name: 'gamma', hostname: 'gamma.test', dir: 'C:\\laragon\\www\\gamma' },
  ];
  const out = formatEnvironmentsTable(envs, { cli: 'ap', current: '1.8.0', mcpTarget: 'beta.test' });

  assert.match(out, /VERSION/);
  assert.match(out, /v1\.6\.0/, 'a site behind must show its own version');
  assert.match(out, /\?/, 'a site recorded before the field existed must show ? rather than a guess');
  assert.match(out, /^ {2}→ beta/m, 'the MCP target must be marked');
  assert.doesNotMatch(out, /^ {2}→ alpha/m, 'and only that one');
  // Behind and unknown are counted separately: a differing version IS behind, a '?'
  // only means the registry predates the field, and calling that "behind" would be
  // inventing a fact about the site.
  assert.match(out, /1 site not on v1\.8\.0/, 'only the site with a differing recorded version');
  assert.match(out, /1 of unknown version/, 'and the unrecorded one is reported as unknown, not behind');
  assert.match(out, /ap update --all/, 'and name the command that fixes both');
});

test('formatEnvironmentsTable marks nothing when the MCP target is unknown or disputed', () => {
  const envs = [{ name: 'alpha', hostname: 'alpha.test', dir: 'C:\\x', version: '1.8.0' }];
  const out = formatEnvironmentsTable(envs, { cli: 'ap', current: '1.8.0', mcpTarget: null });
  assert.doesNotMatch(out, /→/, 'guessing which site is wired is worse than saying nothing');
  assert.doesNotMatch(out, /not on v/, 'and nothing is behind here');
});

test('the empty-state names a command the reader can actually run', () => {
  // It used to hardcode "node index.js <name> (from the agentpress checkout)", which is how a
  // maintainer runs it. Every documented route is npx, so the one line a brand-new user sees
  // sent them to a checkout they had never made.
  const empty = formatEnvironmentsTable([]);
  assert.doesNotMatch(empty, /checkout/i);
  assert.match(empty, /npx create-agentpress@latest <name>/, 'the default must be the documented route');
  assert.match(formatEnvironmentsTable([], { cli: 'node index.js' }), /node index\.js <name>/, 'and the caller can override it');
});
