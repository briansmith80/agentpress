// PHP's CLI SAPI writes display_errors output to STDOUT — the same stream every
// value we read comes back on. Issue #1 (against 1.10.0) is what that costs: on
// PHP 8.5 the pinned WP-CLI 2.12.0 phar emits a deprecation from its bundled
// react/promise on every single invocation, and the whole buffer went into
// .mcp.json as the WordPress application password. Every MCP request 401'd, the
// server came up with zero tools, and the accompanying diagnosis blamed a
// wp-config.php define that was present and correct.
//
// The fixtures below are the REAL output, captured from
//   php-8.5.1-nts\php.exe -d memory_limit=512M wp-cli-2.12.0.phar --version
// on the reporter's PHP version, not an approximation of it. No Laragon, no PHP
// and no network needed to run these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { firstPhpDiagnostic, stripPhpDiagnostics } from '../src/wp.mjs';
import { parseMintedAppPassword } from '../src/mcp.mjs';

const read = (rel) => readFile(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

// Note the leading newline: PHP wraps the notice in PHP_EOL, so the polluted
// buffer does not even start with the diagnostic.
const DEPRECATION =
  'Deprecated: Case statements followed by a semicolon (;) are deprecated, use a colon (:) instead in ' +
  'phar://C:/laragon/usr/bin/wp-cli-2.12.0.phar/vendor/react/promise/src/functions.php on line 369';
const polluted = (value) => `\n${DEPRECATION}\n${value}\n`;

test('stripPhpDiagnostics recovers the value from the real PHP 8.5 buffer', () => {
  assert.equal(stripPhpDiagnostics(polluted('WP-CLI 2.12.0')).trim(), 'WP-CLI 2.12.0');
  assert.equal(stripPhpDiagnostics(polluted('https://example.test')).trim(), 'https://example.test');
  // The env-type probe: this exact comparison is what reported a correct
  // wp-config.php as missing define('WP_ENVIRONMENT_TYPE', 'local').
  assert.equal(stripPhpDiagnostics(polluted('local|1')).trim(), 'local|1');
});

test('stripPhpDiagnostics leaves clean output byte-identical, blank lines included', () => {
  for (const clean of ['local|1', 'one\ntwo', 'a\n\nb\nc', '[{"uuid":"u","name":"agentpress"}]', '']) {
    assert.equal(stripPhpDiagnostics(clean), clean);
  }
});

test('stripPhpDiagnostics is not positional — multi-line values survive pollution', () => {
  // The tempting one-line fix is "take the last non-empty line". It would
  // corrupt every legitimately multi-line `wp eval` read, so this asserts the
  // rule that was chosen instead.
  assert.equal(stripPhpDiagnostics(`\n${DEPRECATION}\nfirst\nsecond\nthird\n`).trim(), 'first\nsecond\nthird');
});

test('stripPhpDiagnostics handles every diagnostic spelling PHP can emit', () => {
  for (const level of ['Deprecated', 'Notice', 'Warning', 'Strict Standards', 'Parse error', 'Fatal error']) {
    assert.equal(stripPhpDiagnostics(`\n${level}: something in /x.php on line 3\nVALUE`).trim(), 'VALUE');
  }
  // log_errors renders the same text with a "PHP " prefix.
  assert.equal(stripPhpDiagnostics('PHP Warning:  x in /y.php on line 1\nVALUE').trim(), 'VALUE');
});

test('stripPhpDiagnostics drops a whole uncaught-throwable block, stack trace and all', () => {
  const fatal =
    '\nFatal error: Uncaught Error: boom in /x.php:3\nStack trace:\n#0 /y.php(9): f()\n#1 {main}\n  thrown in /x.php on line 3\n';
  assert.equal(stripPhpDiagnostics(`${fatal}VALUE`).trim(), 'VALUE');
});

test('stripPhpDiagnostics does not eat output that merely mentions a warning', () => {
  // The line has to LOOK like PHP's own rendering. Prose that only contains the
  // word must survive, or a plugin list describing a warning gets mangled.
  const humanText = 'Warning about nothing\nno colon after the level so this is not a diagnostic';
  assert.equal(stripPhpDiagnostics(humanText), humanText);
});

test('stripPhpDiagnostics survives the SECOND deprecation, which repeats and interleaves', () => {
  // Found while verifying the fix, not in the report: `wp eval` against a real
  // site on 8.5.1 emits a second deprecation from php-cli-tools' Colors.php on
  // every message WP-CLI renders — dozens of copies in one run, positioned
  // wherever the rendering happens rather than only at autoload. That is the
  // reason this filter is positional-agnostic: a value can be sandwiched
  // BETWEEN diagnostics, so neither the first nor the last line is safe to take.
  const colors =
    'Deprecated: Using null as an array offset is deprecated, use an empty string instead in ' +
    'phar://C:/laragon/usr/bin/wp-cli-2.12.0.phar/vendor/wp-cli/php-cli-tools/lib/cli/Colors.php on line 95';
  const noisy = `\n${DEPRECATION}\n${'\n' + colors + '\n'.repeat(1)}local|1\n${colors}\n`;
  assert.equal(stripPhpDiagnostics(noisy).trim(), 'local|1');
  // Fifty copies, as observed, must not change the answer.
  const flood = `\n${DEPRECATION}\n${`\n${colors}\n`.repeat(50)}local|1\n`;
  assert.equal(stripPhpDiagnostics(flood).trim(), 'local|1');
});

test("WP-CLI's own Error: text survives the filter — it is not a PHP diagnostic", () => {
  // Real capture: 10KB of deprecations around WP-CLI's actual failure message.
  // Dropping that message would turn every diagnosable failure into a blank one.
  const buffer = `\n${DEPRECATION}\nError: Your PHP installation appears to be missing the MySQL extension.\n${DEPRECATION}\n`;
  assert.equal(stripPhpDiagnostics(buffer).trim(), 'Error: Your PHP installation appears to be missing the MySQL extension.');
});

test('firstPhpDiagnostic names the cause and stays silent on clean output', () => {
  assert.equal(firstPhpDiagnostic(polluted('local|1')), DEPRECATION);
  assert.equal(firstPhpDiagnostic('local|1'), null);
  assert.equal(firstPhpDiagnostic(''), null);
  assert.equal(firstPhpDiagnostic(undefined), null);
});

test('parseMintedAppPassword returns the password hiding behind the deprecation', () => {
  // The shape WordPress actually mints: wp_generate_password( 24, false ).
  const real = 'AbCd1234EfGh5678IjKl9012';
  assert.equal(parseMintedAppPassword(polluted(real)), real);
  assert.equal(parseMintedAppPassword(`${real}\n`), real);
});

test('parseMintedAppPassword refuses a buffer it cannot reduce to one credential', () => {
  // Anything still carrying prose after the strip must fail loudly at creation —
  // the alternative is the opaque 401 an hour later that issue #1 describes.
  for (const bad of ['', '   ', 'not a password at all', 'AbCd1234EfGh5678IjKl9012\nAbCd1234EfGh5678IjKl9013', 'short']) {
    assert.throws(() => parseMintedAppPassword(bad), /unexpected shape/);
  }
});

test('parseMintedAppPassword never echoes the buffer it rejected', () => {
  // The failure this guards holds a LIVE credential right behind the prose, so
  // the message names the cause and nothing else. An error string is the one
  // place a secret leaks into a console, a log, and an agent's transcript.
  const secret = 'AbCd1234EfGh5678IjKl9012';
  let err;
  try {
    parseMintedAppPassword(`\n${DEPRECATION}\nnot-a-password ${secret}\n`);
  } catch (caught) {
    err = caught;
  }
  assert.ok(err, 'a buffer that is not one credential must throw');
  assert.ok(!err.message.includes(secret), 'the rejected buffer must not be echoed');
  assert.match(err.message, /Cause: PHP wrote a diagnostic/);
  assert.match(err.message, /display_errors=stderr/);
});

test('every PHP we spawn is told to send diagnostics to stderr, not stdout', async () => {
  // The one-line root fix, asserted at the source because CI has no PHP to run.
  // All three call sites matter: runWp is ours, the wp.bat shim is what `npm run
  // wp` and the frozen site menu go through, and runPhpCode is every scalar
  // `php -r` read (PHP version, php.ini summary, LIBXML_VERSION).
  const wp = await read('src/wp.mjs');
  assert.match(wp, /const PHP_DISPLAY_ERRORS = 'stderr';/);
  const sites = [...wp.matchAll(/display_errors=\$\{PHP_DISPLAY_ERRORS\}/g)];
  assert.equal(sites.length, 3, 'expected runWp, the wp.bat shim and runPhpCode to all pass the flag');
  // Nothing may spawn php with a bare -r again: that is the read this bug lives in.
  const bare = [...wp.matchAll(/spawnCapture\(php, \['-r'/g)];
  assert.deepEqual(bare, [], 'route `php -r` through runPhpCode so the stdout guards apply');
});

test('no value from a WP-CLI or PHP call is read straight off a raw stdout buffer', async () => {
  // The generalised assertion, which naming individual call sites would not
  // give. Tracks the variables that hold a runWp/runWpEvalFile/runPhpCode result
  // and flags any read of `<that>.stdout` that does not go through the filter.
  // Failure branches may still quote the raw buffer: that text is for a human to
  // read, not for the code to act on, so `(stderr || stdout)` is allowed.
  const offenders = [];
  for (const rel of ['src/mcp.mjs', 'src/wordpress.mjs', 'src/admin-login.mjs', 'src/plugins.mjs', 'src/destroy.mjs', 'src/doctor.mjs']) {
    const src = await read(rel);
    const held = new Set(
      [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+(?:runWp|runWpEvalFile|runPhpCode)\(/g)].map((m) => m[1]),
    );
    if (!held.size) continue;
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return; // comment
      for (const name of held) {
        if (!new RegExp(`\b${name}\.stdout\b`).test(line)) continue;
        if (/stripPhpDiagnostics/.test(line)) continue;
        if (new RegExp(`stderr \|\| ${name}\.stdout`).test(line)) continue; // failure text for a human
        // A membership test tolerates extra text ahead of the value; turning the
        // buffer INTO a value does not.
        if (/JSON\.parse|\.trim\(\)|new URL\(|\.split\(|parseInt/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'read these through stripPhpDiagnostics');
});

test('the three reads issue #1 corrupted are pinned to the filter', async () => {
  // Regression pins, named individually because these are the ones a real user
  // watched break: the application password, the environment-type probe, and the
  // one-click admin login URL.
  assert.match(await read('src/mcp.mjs'), /const password = stripPhpDiagnostics\(stdout\)\.trim\(\);/);
  assert.match(await read('src/wordpress.mjs'), /const out = stripPhpDiagnostics\(probe\.stdout\)\.trim\(\);/);
  assert.match(await read('src/admin-login.mjs'), /const out = stripPhpDiagnostics\(result\.stdout\)\.trim\(\);/);
});
