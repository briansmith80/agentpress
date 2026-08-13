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
