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
    // With or without the list it is about to draw: menuScreen(options) hands back the rows it used.
    assert.match(before, /menuScreen\(\w*\);/, `choose() at line ${i + 1} is not preceded by menuScreen()`);
  });
});

test('the chooser never draws a row wider than the window, at any width', async () => {
  // A wrapped row is two rows on screen but one in the repaint's count, so
  // each keypress left the question line behind: eight "? Live site …" lines
  // after eight keypresses in a 75-column pane (operator screenshot,
  // 2026-11-11). This RUNS the real chooser against a fake terminal.
  const src = menu.replace(/\r\n/g, '\n');
  const start = src.indexOf('async function choose(message, options, above = 0) {');
  assert.ok(start >= 0, 'chooser not found');
  const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
  const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const options = [
    { label: 'Check status', hint: 'compare this site with live', value: 'a' },
    { label: 'Pull content from live', hint: 'asks first; this local site becomes a copy of live', value: 'b' },
    // A blank row above it, and a hint painted by the row itself: both are rows and widths the repaint must count.
    { label: 'A label that is itself far too long to fit in a narrow window at all', hint: 'and a hint', value: 'c', gap: true, paint: (s) => `\x1b[33m${s}\x1b[0m` },
    { label: 'Back', value: 'back', gap: true },
  ];
  for (const columns of [30, 60, 75, 120]) {
    const writes = [];
    const listeners = [];
    const fake = {
      stdout: { columns, write: (s) => writes.push(s) },
      stdin: { setRawMode() {}, resume() {}, pause() {}, on: (_e, fn) => listeners.push(fn), removeListener() {} },
    };
    const choose = new Function('process', 'emitKeypressEvents', 'pink', 'dim', `${body}; return choose;`)(fake, () => {}, (s) => `\x1b[35m${s}\x1b[0m`, (s) => `\x1b[2m${s}\x1b[0m`);
    const picked = choose('Live site somesite.example with a rather long question line', options);
    for (let i = 0; i < 5; i++) listeners[0](undefined, { name: 'down' });
    listeners[0]('\r', { name: 'return' });
    assert.equal(await picked, 'b', 'five downs over four options lands on the second');
    for (const w of writes) {
      for (const row of strip(w).split('\n')) assert.ok(row.length < columns, `${columns} columns: a ${row.length}-wide row would wrap: "${row}"`);
    }
    // And the climb before each repaint equals the rows the previous paint drew.
    let drawn = 0;
    for (const w of writes) {
      const up = /^\x1b\[(\d+)A/.exec(w);
      if (up) assert.equal(Number(up[1]), drawn, 'repaint climbs exactly what was drawn');
      else drawn = strip(w).split('\n').length - 1;
    }
  }
});

test('the chooser gives up its blank rows and key legend before it runs off the bottom', async () => {
  // A list taller than the window scrolls it; the climb then stops at the top
  // row and every keypress paints a second copy underneath. Groups and the
  // legend are the only rows that can go, so they go first.
  const src = menu.replace(/\r\n/g, '\n');
  const start = src.indexOf('async function choose(message, options, above = 0) {');
  const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
  const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const options = [
    { label: 'One', value: 'a' },
    { label: 'Two', value: 'b', gap: true },
    { label: 'Three', value: 'c', gap: true },
    { label: 'Back', value: 'back', gap: true },
  ];
  const paint = (rows, above) => {
    const writes = [];
    const fake = { stdout: { columns: 80, rows, write: (s) => writes.push(s) }, stdin: { setRawMode() {}, resume() {}, pause() {}, on() {}, removeListener() {} } };
    new Function('process', 'emitKeypressEvents', 'pink', 'dim', `${body}; return choose;`)(fake, () => {}, (s) => s, (s) => s)('Pick', options, above);
    return strip(writes[0]).split('\n').slice(0, -1);
  };
  // question + blank + 4 options, then 3 blank rows between groups and 2 for the legend.
  assert.equal(paint(40, 10).length, 11, 'room for everything');
  assert.equal(paint(19, 10).length, 8, 'no room for the groups: the legend stays, the blank rows go');
  assert.equal(paint(17, 10).length, 6, 'no room for either');
  for (const [rows, above] of [[40, 10], [19, 10], [17, 10], [12, 10]]) {
    const drawn = paint(rows, above);
    // The cursor ends on the row after the list, so the list plus one must fit under what is above it.
    if (rows >= above + 7) assert.ok(above + drawn.length + 1 <= rows, `${rows} rows: ${drawn.length} drawn under ${above} runs off the bottom`);
  }
  assert.ok(paint(40, 10).some((row) => row.includes('0  Back')), 'the row that leaves shows the key that picks it');
  assert.ok(paint(40, 10).some((row) => row.includes('1  One')), 'a row shows its number');
});

test('the menu names the plugin zip the tool writes', async () => {
  // `push plugin` writes <slug>.zip into the site folder and the menu then
  // copies that path and offers the folder. A different name is a copied
  // path to a file that is not there.
  const { PLUGIN_SLUG } = await import('../src/push.mjs');
  assert.ok(menu.includes(`const PUSH_ZIP = '${PLUGIN_SLUG}.zip';`), 'the menu looks for a different file than push plugin writes');
});

test('the feedback link carries versions and nothing about the site', () => {
  const src = menu.replace(/\r\n/g, '\n');
  const start = src.indexOf('function feedbackUrl() {');
  assert.ok(start >= 0, 'feedbackUrl not found');
  const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
  // An issue is public the moment it is filed, and this repo's are indexed.
  for (const name of ['SITE', 'HOST', 'CWD', 'env.', 'liveHost']) assert.ok(!body.includes(name), `the prefilled issue reads ${name}`);
  const url = new Function('VERSION', 'process', 'release', `${body}; return feedbackUrl();`)('9.9.9', { version: 'v22.0.0' }, () => '10.0.1');
  assert.ok(url.startsWith('https://github.com/briansmith80/agentpress/issues/new?body='), url);
  assert.match(decodeURIComponent(url), /AgentPress 9\.9\.9 · Node v22\.0\.0 · Windows 10\.0\.1/);
});
