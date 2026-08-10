// The argument refusals, and the typo matcher that gates one of them.
//
// Every rule here replaces a SILENT misinterpretation on a command that
// provisions or deletes. Two of them were destructive:
//   `destroy <other-site> --yes` ignored the name and deleted the folder you
//                                were standing IN
//   `--premium none --yes`       installed and licensed EVERY commercial plugin,
//                                the opposite of what was typed
//
// These drive `refuseInvocation`, the PURE rule set, and not `create()`. That is
// deliberate and was learned the hard way: while proving an earlier version of
// these tests was load-bearing, a guard was disabled and the same argv was let
// through to the real dispatcher. It scaffolded a site called `destory` —
// folder, database, database user, registry entry and a re-pointed
// machine-global MCP wiring — which is exactly the harm the guard prevents.
// Anyone repeating that mutation check against this file now gets a string
// comparison instead of a side effect. One wiring test at the bottom calls
// `create()`, and its argv is chosen so that even an unguarded fall-through is
// inert.
//
// The matcher matrix is the other load-bearing half. `closestCommand` now gates
// a refusal, so a match that is too eager stops a legitimate scaffold dead.
// `test`, `host`, `best` and `hello` all matched `list`/`help` under the old flat
// distance <= 2, and those are exactly the names people give throwaway sites. If
// the matrix is ever relaxed, the refusal must be relaxed with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentPressMarkers, closestCommand, create, parseArgs, refuseInvocation } from '../src/engine.js';
import { validateSiteName } from '../src/names.mjs';

/** The refusal for an argv, or null. Pure: nothing is executed. */
const refusalFor = (argv) => refuseInvocation(parseArgs(argv));

test('parseArgs collects single-dash arguments instead of dropping them', () => {
  // `-premium=none` used to vanish with no output at all.
  const args = parseArgs(['mysite', '-premium=none', '-x']);
  assert.deepEqual(args.stray, ['-premium=none', '-x']);
  assert.equal(args.command, 'mysite', 'a stray must not become the command');
  assert.deepEqual(args.positional, ['mysite'], 'a stray must not become a positional either');
});

test('parseArgs still treats the four real short flags as flags, not strays', () => {
  const args = parseArgs(['mysite', '-y']);
  assert.equal(args.yes, true);
  assert.deepEqual(args.stray, []);
});

test('parseArgs only attaches a flag value with =, which is the trap the refusal catches', () => {
  const spaced = parseArgs(['--premium', 'none']);
  assert.equal(spaced.flags.premium, true, 'no value attaches, so the flag is boolean true');
  assert.deepEqual(spaced.positional, ['none'], 'and the intended value becomes a positional');

  const attached = parseArgs(['--premium=none']);
  assert.equal(attached.flags.premium, 'none');
});

test('parseArgs reads the two override flags this safety pass introduced', () => {
  assert.equal(parseArgs(['resume', 'x', '--adopt']).flags.adopt, true);
  assert.equal(parseArgs(['destory', '--yes', '--force-name']).flags['force-name'], true);
});

test('closestCommand catches the typos worth catching', () => {
  for (const [typo, expected] of [
    ['destory', 'destroy'],
    ['dcotor', 'doctor'],
    ['doctro', 'doctor'],
    ['reiwre', 'rewire'],
    ['updat', 'update'],
    ['lists', 'list'],
    ['setups', 'setup'],
  ]) {
    assert.equal(closestCommand(typo), expected, `${typo} should suggest ${expected}`);
  }
});

test('closestCommand leaves ordinary site names alone (it used to flag all of these)', () => {
  for (const name of ['test', 'host', 'best', 'hello', 'blog', 'docs', 'shop', 'api', 'demo', 'staging', 'client-site', 'aptest901']) {
    assert.equal(closestCommand(name), null, `${name} is a legitimate site name and must not be flagged`);
  }
});

test('closestCommand never flags an exact command, in any case', () => {
  for (const cmd of ['doctor', 'setup', 'list', 'resume', 'update', 'rewire', 'destroy', 'help', 'version']) {
    assert.equal(closestCommand(cmd), null);
    assert.equal(closestCommand(cmd.toUpperCase()), null, 'case-only input is handled by its own refusal, not this');
  }
});

test('a capitalised command can never have been a valid site name, so refusing it loses nothing', () => {
  // This is what makes the case-only refusal provably safe rather than a guess.
  for (const cmd of ['Doctor', 'DESTROY', 'Update']) {
    assert.notEqual(validateSiteName(cmd).length, 0, `${cmd} must be rejected as a site name`);
  }
});

test('destroy refuses a site name instead of silently acting on the current folder', () => {
  const message = refusalFor(['destroy', 'other-site', '--yes']);
  assert.ok(message, 'must refuse');
  assert.match(message, /acts on the site folder you are standing in/);
  assert.match(message, /other-site/, 'the refusal must name what it will not act on');
  assert.match(message, /cd /, 'and must say how to actually do it');
});

test('update and rewire refuse a surplus positional too', () => {
  for (const cmd of ['update', 'rewire']) {
    const message = refusalFor([cmd, 'some-site']);
    assert.ok(message, `${cmd} should refuse`);
    assert.match(message, /acts on the site folder you are standing in/);
  }
});

test('resume still accepts its site name, since it is not a cwd command', () => {
  assert.equal(refusalFor(['resume', 'mysite']), null);
  assert.equal(refusalFor(['resume', 'mysite', '--adopt']), null);
});

test('a value flag written with a space is refused, not silently inverted', () => {
  const message = refusalFor(['--premium', 'none']);
  assert.ok(message);
  assert.match(message, /--premium needs its value attached with =/);
  assert.match(message, /opposite of --premium=none/, 'the refusal must state the consequence it prevents');
  assert.ok(refusalFor(['--plugins', 'seo']), '--plugins has the same trap');
});

test('a correctly attached value flag is accepted', () => {
  assert.equal(refusalFor(['mysite', '--premium=none', '--yes']), null);
  assert.equal(refusalFor(['mysite', '--premium=all', '--plugins=wordpress-seo']), null);
});

test('a case-only command typo is refused with the correct spelling', () => {
  const message = refusalFor(['Doctor']);
  assert.ok(message);
  assert.match(message, /Commands are lowercase/);
  assert.match(message, /doctor/);
});

test('a stray single-dash argument is refused rather than ignored', () => {
  const message = refusalFor(['-yes', 'mysite']);
  assert.ok(message);
  assert.match(message, /Unrecognised argument/);
  assert.match(message, /two dashes/, 'the commonest cause deserves the hint');
});

test('a mistyped command under --yes is refused, because nothing else would catch it', () => {
  const message = refusalFor(['destory', '--yes']);
  assert.ok(message);
  assert.match(message, /looks like a mistyped `destroy`/);
  assert.match(message, /--force-name/, 'there must be a documented way through');
});

test('the same typo is allowed through interactively, where confirmScaffold shows the name', () => {
  assert.equal(refusalFor(['destory']), null, 'no --yes means a human still sees the [y/N]');
  assert.equal(refusalFor(['destory', '--yes', '--force-name']), null, '--force-name is the documented override');
});

test('every real command and a plain site name pass cleanly', () => {
  for (const argv of [['doctor'], ['setup'], ['list'], ['update'], ['rewire'], ['destroy'], ['register-quick-app'], ['mysite'], ['test', '--yes'], ['aptest901', '--yes', '--premium=none']]) {
    assert.equal(refuseInvocation(parseArgs(argv)), null, `${argv.join(' ')} must not be refused`);
  }
});

test('the documented escape hatch works in every spelling a user would write', () => {
  // The first version compared against boolean `true`, so `--force-name=true` was
  // refused by the very message that recommended --force-name. Found in review.
  for (const spelling of ['--force-name', '--force-name=true', '--force-name=1', '--force-name=yes', '--force-name=']) {
    assert.equal(refusalFor(['destory', '--yes', spelling]), null, `${spelling} must be accepted`);
  }
  assert.ok(refusalFor(['destory', '--yes', '--force-name=false']), 'an explicit false must still refuse');
});

test('a misspelled value flag is refused, because leaving it unset is not neutral', () => {
  // `--premim=none --yes` left premium unset, and unset under --yes means install
  // EVERY premium plugin: the same inversion the space-separated form caused.
  for (const argv of [
    ['mysite', '--premim=none', '--yes'],
    ['mysite', '--Premium=none', '--yes'],
    ['mysite', '--premiums=none', '--yes'],
    ['mysite', '--plugin=wordpress-seo'],
  ]) {
    const message = refusalFor(argv);
    assert.ok(message, `${argv.join(' ')} should refuse`);
    assert.match(message, /did you mean --(premium|plugins)\?/);
  }
});

test('unknown flags that are NOT near a value flag stay a warning, for forward compatibility', () => {
  // README documents --setup-script= / --dev-script= as accepted but unimplemented,
  // so a blanket refuse-all-unknown-flags rule would break those runs.
  assert.equal(refusalFor(['mysite', '--setup-script=x', '--yes']), null);
  assert.equal(refusalFor(['mysite', '--dev-script=x', '--yes']), null);
});

test('the --plugins refusal never suggests `none`, which is a literal slug there', () => {
  // A shared example template produced "--plugins=none". `none` is not special for
  // --plugins: it installs as a wordpress.org slug, fails, and kills the scaffold
  // AFTER the database and WordPress exist, then gets replayed by the resume hint.
  const message = refusalFor(['--plugins', 'seo']);
  assert.ok(message);
  assert.doesNotMatch(message, /--plugins=none/, 'that value would hard-fail a scaffold');
  assert.match(message, /--plugins=wordpress-seo/);
  assert.match(refusalFor(['--premium', 'none']), /--premium=none/, 'premium does accept none');
});

test('the scaffold path refuses a surplus positional too, not just the cwd commands', () => {
  // Same silently-dropped-positional bug: this provisioned a site named "create".
  const message = refusalFor(['create', 'mysite', '--yes']);
  assert.ok(message);
  assert.match(message, /Expected one site name/);
  assert.match(message, /"create"/, 'must say which name it would have used');
  assert.match(message, /hyphens/, 'the real cause is usually a space in the name');
});

test('closestCommand catches transpositions of the short commands as well', () => {
  // The 6-character floor that protects `test`/`host` also dropped every
  // transposition of list/help/setup, so an adjacent swap is matched explicitly.
  for (const [typo, expected] of [
    ['lsit', 'list'],
    ['ilst', 'list'],
    ['hlep', 'help'],
    ['hepl', 'help'],
    ['setpu', 'setup'],
  ]) {
    assert.equal(closestCommand(typo), expected, `${typo} should suggest ${expected}`);
  }
});

test('agentPressMarkers demands SITE_HOST in .env, since a bare .env is anyones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ap-markers-'));

  const foreign = join(root, 'foreign');
  await mkdir(join(foreign, 'public'), { recursive: true });
  await writeFile(join(foreign, 'public', 'index.php'), '<?php // someone else\n');
  await writeFile(join(foreign, '.env'), 'APP_KEY=abc\nDB_HOST=127.0.0.1\n');
  assert.deepEqual(await agentPressMarkers(foreign), [], 'a bare .env must not count as ours');

  const ours = join(root, 'ours');
  await mkdir(ours, { recursive: true });
  await writeFile(join(ours, '.env'), 'DB_NAME=x\nSITE_HOST=ours.test\n');
  assert.deepEqual(await agentPressMarkers(ours), ['.env with SITE_HOST']);
});

test('agentPressMarkers recognises a scaffold that died in the staging window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ap-markers-'));
  const staged = join(root, 'staged');
  await mkdir(join(staged, 'public'), { recursive: true });
  // Exactly what the staging step writes, via the shared marker constant.
  await writeFile(join(staged, 'public', 'index.php'), '<?php\n// agentpress placeholder — replaced by `wp core download`\n');
  assert.deepEqual(await agentPressMarkers(staged), ['public/index.php (scaffold placeholder)']);

  const parked = join(root, 'parked');
  await mkdir(parked, { recursive: true });
  await writeFile(join(parked, '.agentpress-pending.json'), '{"plugins":[],"premium":[]}\n');
  assert.deepEqual(await agentPressMarkers(parked), ['.agentpress-pending.json']);
});

test('agentPressMarkers says nothing about an empty or missing folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ap-markers-'));
  assert.deepEqual(await agentPressMarkers(root), []);
  assert.deepEqual(await agentPressMarkers(join(root, 'does-not-exist')), []);
});

test('create() actually consults the rules (they would otherwise be dead code)', async () => {
  // `destroy other-site --yes` is chosen on purpose: if this guard were ever
  // removed, the fall-through is destroyCommand against the repo root, which has
  // no .env and bails harmlessly. Do not swap in an argv that could scaffold.
  const priorExit = process.exitCode;
  const priorLog = console.log;
  const priorWrite = process.stdout.write;
  let out = '';
  console.log = (...parts) => {
    out += `${parts.join(' ')}\n`;
  };
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    await create({ argv: ['destroy', 'other-site', '--yes'] });
  } finally {
    console.log = priorLog;
    process.stdout.write = priorWrite;
  }
  const exitCode = process.exitCode;
  process.exitCode = priorExit; // bail() sets 1; never fail the suite from a refusal test
  assert.equal(exitCode, 1, 'a refusal must set a failing exit code');
  assert.match(out, /acts on the site folder you are standing in/);
});
