// template/scripts/agentpress.mjs is frozen into every scaffolded site and
// cannot import from src/, so it carries deliberate duplicated copies. CLAUDE.md
// requires those to stay in sync and says to verify it programmatically rather
// than by eye — this is that verification.
//
// Drift here is invisible in normal use: the copies only diverge for users of
// already-scaffolded sites, who are the least likely to report it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFile(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const menu = await read('template/scripts/agentpress.mjs');
const ansi = await read('src/ansi.mjs');
const mcp = await read('src/mcp.mjs');
const agents = await read('src/agents.mjs');
const adminLogin = await read('src/admin-login.mjs');
const engine = await read('src/engine.js');
const wp = await read('src/wp.mjs');

test('the frozen menu imports nothing from src/ (src does not exist beside a scaffolded site)', () => {
  const bad = [...menu.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).filter((s) => !s.startsWith('node:'));
  assert.deepEqual(bad, [], `frozen menu must only import node: builtins, found: ${bad.join(', ')}`);
});

test('the banner art is identical to src/ansi.mjs', () => {
  // Compare the art line by line: the two files indent the literal
  // differently, and that is not drift.
  const grab = (src) =>
    src
      .match(/const BANNER_LINES = \[([\s\S]*?)\];/)?.[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
  assert.ok(grab(menu), 'menu has BANNER_LINES');
  assert.equal(grab(menu), grab(ansi), 'BANNER_LINES drifted between the frozen menu and src/ansi.mjs');
});

test('the colour gate is identical to src/ansi.mjs (FORCE_COLOR=0 must mean off in both)', () => {
  const grabOff = (src) => src.match(/const OFF_VALUES = new Set\(\[([^\]]*)\]\)/)?.[1]?.replace(/\s/g, '');
  assert.ok(grabOff(menu), 'menu has OFF_VALUES');
  assert.equal(grabOff(menu), grabOff(ansi), 'the colour opt-out list drifted');
});

test('agent command names match src/agents.mjs', () => {
  const grab = (src, name) => {
    const body = src.match(new RegExp(`${name} = \\{([^}]*)\\}`))?.[1] || '';
    return [...body.matchAll(/(\w[\w-]*)\s*:\s*'([^']+)'/g)].map((m) => `${m[1]}=${m[2]}`).sort().join(',');
  };
  const fromMenu = grab(menu, 'AGENT_COMMANDS');
  const fromSrc = grab(agents, 'AGENT_COMMANDS');
  assert.ok(fromMenu, 'menu has AGENT_COMMANDS');
  assert.equal(fromMenu, fromSrc, 'the menu launches different binaries than the scaffolder detects');
  // The rename fallbacks (cursor-agent → agent) are part of the same contract:
  // detection accepting a name the menu never launches would strand the user
  // with a wired agent and a dead menu button.
  const fallbackMenu = grab(menu, 'AGENT_COMMAND_FALLBACKS');
  const fallbackSrc = grab(agents, 'AGENT_COMMAND_FALLBACKS');
  assert.ok(fallbackMenu, 'menu has AGENT_COMMAND_FALLBACKS');
  assert.equal(fallbackMenu, fallbackSrc, 'the rename fallbacks drifted between the menu and the scaffolder');
  assert.equal(fromSrc.includes('cursor=cursor-agent'), true, 'cursor primary should stay the unambiguous cursor-agent');
});

test('the menu reads the same agent config paths and JSON shapes as src/mcp.mjs', () => {
  for (const fragment of ["'.claude.json'", "'.cursor', 'mcp.json'", "'.config', 'opencode', 'opencode.json'"]) {
    assert.ok(menu.includes(fragment), `menu is missing the config path ${fragment}`);
    assert.ok(mcp.includes(fragment), `src/mcp.mjs is missing the config path ${fragment}`);
  }
  for (const shape of ['mcpServers?.wordpress?.env?.WP_API_URL', 'mcp?.wordpress?.environment?.WP_API_URL']) {
    assert.ok(menu.includes(shape), `menu is missing the JSON shape ${shape}`);
    assert.ok(mcp.includes(shape), `src/mcp.mjs is missing the JSON shape ${shape}`);
  }
});

test('both copies resolve the home directory the same way', () => {
  assert.ok(menu.includes('homedir()'), 'the menu must use homedir(), not USERPROFILE||HOME (which can yield a relative path)');
  assert.ok(mcp.includes('homedir()'), 'src/mcp.mjs must use homedir()');
});

test('the admin-login PHP payload is the same in both copies', () => {
  // Normalise whitespace and JS-level backslash escaping: the two copies live
  // in different string contexts, so only the PHP itself is comparable.
  const grab = (src) =>
    src
      .match(/\$admins = get_users[\s\S]*?login_url/)?.[0]
      ?.replace(/\\\\/g, '\\')
      .replace(/\s+/g, ' ')
      .trim();
  const inMenu = grab(menu);
  const inSrc = grab(adminLogin);
  assert.ok(inMenu, 'the frozen menu must carry the admin-login payload');
  assert.ok(inSrc, 'src/admin-login.mjs must carry the payload');
  assert.equal(inMenu, inSrc, 'the admin-login PHP drifted between its two copies');
});

test('the SITE_HOST hostname regex is identical in both copies (it already shipped broken once)', () => {
  // The menu's copy once read `(:d{1,5})?` instead of `(:\d{1,5})?`, matching a
  // literal "d". Any SITE_HOST with a port was rejected and the menu refused to
  // start, in a file the user cannot easily fix. This is the assertion that would
  // have caught it, and it is the reason this test file exists.
  const grab = (src) => src.match(/\/\^\[a-z0-9\]\(\[a-z0-9\.-\]\*\[a-z0-9\]\)\?\(:\\d\{1,5\}\)\?\$\/i/)?.[0];
  const inMenu = grab(menu);
  const inSrc = grab(engine);
  assert.ok(inMenu, 'the frozen menu must validate SITE_HOST with the shared regex');
  assert.ok(inSrc, 'src/engine.js must validate SITE_HOST with the shared regex');
  assert.equal(inMenu, inSrc, 'the hostname regex drifted between its two copies');
});

test('the pink wordmark colour is identical in both copies', () => {
  // Two escape sequences with a truecolor fallback. One shade off is invisible in
  // review and obvious side by side.
  const grab = (src) => src.match(/\(process\.env\.COLORTERM \|\| ''\)\.includes\('truecolor'\)[^;]+/)?.[0];
  assert.ok(grab(menu), 'the menu must define PINK');
  assert.equal(grab(menu), grab(ansi), 'the pink escape codes drifted');
});

test('BANNER_WIDTH is identical in both copies (it right-aligns the subtitle)', () => {
  const grab = (src) => src.match(/const BANNER_WIDTH = (\d+);/)?.[1];
  assert.ok(grab(menu), 'the menu must define BANNER_WIDTH');
  assert.equal(grab(menu), grab(ansi), 'BANNER_WIDTH drifted, so the subtitle no longer lines up');
});

test('the PHP-diagnostics filter is identical in both copies', () => {
  // Issue #1: on PHP 8.5 the pinned WP-CLI phar prints a deprecation to STDOUT
  // before every value, and this filter is what keeps it out of the credential
  // and out of the one-click login URL. The menu's copy protects already-
  // scaffolded sites, where the scaffolder's copy is not present at all — so
  // drift here reads as "fixed" while a whole class of user stays broken.
  const grabFn = (src) => src.match(/function stripPhpDiagnostics\(text\) \{[\s\S]*?\n\}/)?.[0]?.replace(/\s+/g, ' ');
  assert.ok(grabFn(menu), 'the frozen menu must carry stripPhpDiagnostics');
  assert.ok(grabFn(wp), 'src/wp.mjs must define stripPhpDiagnostics');
  assert.equal(grabFn(menu), grabFn(wp), 'stripPhpDiagnostics drifted between its two copies');
  // The two patterns it depends on, compared separately: an equal function body
  // over different regexes would filter different things.
  for (const name of ['PHP_DIAGNOSTIC_LINE', 'PHP_DIAGNOSTIC_CONT']) {
    const grab = (src) => src.match(new RegExp(`const ${name} =\\s*([^;]+);`))?.[1]?.replace(/\s+/g, '');
    assert.ok(grab(menu), `the menu must define ${name}`);
    assert.equal(grab(menu), grab(wp), `${name} drifted between its two copies`);
  }
});

test('every AGENTPRESS_* env read in the frozen menu goes through envOn', () => {
  // The generalised version of the FORCE_COLOR=0 bug: an env var is a string, so a
  // bare truthiness test makes "=0" mean ON. Two gates in this file read
  // process.env directly and both were inverted. Asserting the SHAPE catches the
  // next one automatically, which naming individual vars would not.
  const offenders = menu
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /process\.env\.(AGENTPRESS|KATALYST)_/.test(line))
    .filter(([, line]) => !/envOn\(/.test(line));
  assert.deepEqual(offenders, [], 'read these through envOn(), or "=0" will mean on');
});

test('every menu item the push hints name is a real label in the frozen menu', async () => {
  // src/push.mjs tells someone inside the menu which ITEM to pick next. An
  // item the menu does not have is worse than the long command it replaced.
  const { MENU_LABELS } = await import('../src/push.mjs');
  for (const [command, label] of Object.entries(MENU_LABELS)) {
    for (const part of label.split(' → ')) {
      assert.ok(menu.includes(`label: '${part}'`), `push hint for "${command}" names "${part}", which is not a menu label`);
    }
    // Connect is the one item that is not a bare command line: it asks for the
    // pasted line first. Every other item's value IS the command it runs.
    if (command !== 'push connect') assert.ok(menu.includes(`value: '${command}'`), `the menu has no item that runs "${command}"`);
  }
});

test('the menu accepts exactly the connection lines src/push.mjs parses', async () => {
  const push = await read('src/push.mjs');
  const shape = '/^agentpress-push:[A-Za-z0-9_-]+$/';
  // The menu hands the pasted line to a shell, so its check is the security
  // boundary; the parser's is the same shape, so nothing valid is refused.
  assert.ok(menu.includes(`${shape}.test(line)`), 'the menu no longer validates the pasted line with the known shape');
  // Same characters, plus the one capture group the parser reads the payload from.
  assert.ok(push.includes('/^agentpress-push:([A-Za-z0-9_-]+)$/.exec(raw)'), 'src/push.mjs parses a different shape than the menu validates');
});

test('the menu shows the wordmark once: everything of ours it runs is told to skip it', () => {
  // Operator screenshot, 2026-11-11: each Live site pick printed the banner
  // again and the results were lost between five wordmarks.
  assert.match(menu, /const OWN_TOOL_ENV = \{ \.\.\.process\.env, AGENTPRESS_NO_BANNER: '1', AGENTPRESS_MENU: '1' \}/);
  const ownRuns = [...menu.matchAll(/runInherit\('(?:npx|node)',[^\n]*/g)].map((m) => m[0]);
  assert.ok(ownRuns.length >= 4, 'expected the rewire, update and two Live site call sites');
  for (const call of ownRuns) assert.ok(call.includes('env: OWN_TOOL_ENV'), `runs our own tool with the banner on: ${call}`);
});

test('the menu gives the terminal its own screen back however it ends, and never deletes history', () => {
  // The menu draws on the alternate screen. Left there after a crash, the
  // shell prompt comes back with no history above it and nothing scrolls.
  assert.ok(menu.includes("process.on('exit', showNormalScreen)"), 'the alternate screen is not left on exit');
  // ESC[3J wipes the scrollback and ESC[2J pushes or wipes the visible screen
  // depending on the terminal. Neither belongs here: what was in the terminal
  // before the menu opened is the user's, not ours.
  assert.ok(!menu.includes('\x1b[3J') && !menu.includes('\x1b[2J'), 'the menu must not clear the normal screen or its scrollback');
});

test('every menu question is drawn on a fresh screen', () => {
  // A chooser drawn without a repaint lands under whatever was there, which
  // is the pile-up the one-screen design exists to remove.
  const lines = menu.split('\n');
  lines.forEach((line, i) => {
    if (!/await choose\(/.test(line)) return;
    const before = lines.slice(Math.max(0, i - 3), i).join('\n');
    assert.match(before, /menuScreen\(\);/, `choose() at line ${i + 1} is not preceded by menuScreen()`);
  });
});
