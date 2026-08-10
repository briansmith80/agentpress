// AGENTS.md and .claude/commands/verify.md are frozen into each scaffolded site,
// so a mistake here reaches users who cannot easily fix it and may not notice.
// Two classes of failure these pin:
//   1. Packaging — .claude/ is a dot-directory inside template/, and npm has a
//      history of dropping those. If it vanishes from the tarball, /verify
//      silently does not exist for anyone who installed from npm.
//   2. Drift — the holding page doubles as a regression test, so its wordmark
//      must match the CLI's and survive templating intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTemplates } from '../src/templates.mjs';

const repo = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel) => readFile(repo(rel), 'utf8');

const VARS = {
  PROJECT_NAME: 'demo-site',
  SITE_HOST: 'demo-site.test',
  SITE_SCHEME: 'https',
  AGENTPRESS_VERSION: '0.0.0',
  WP_ADMIN_USER: 'admin',
  WP_ADMIN_EMAIL: 'admin@example.com',
  WP_BAT_ESCAPED: 'C:\\\\laragon\\\\usr\\\\bin\\\\wp.bat',
};

async function render() {
  const dest = await mkdtemp(join(tmpdir(), 'ap-agentfiles-'));
  await copyTemplates(repo('template'), dest, VARS);
  return dest;
}

test('both agent files land in a scaffolded site, at the paths agents look in', async () => {
  const dest = await render();
  await assert.doesNotReject(() => readFile(join(dest, 'AGENTS.md'), 'utf8'), 'AGENTS.md missing');
  await assert.doesNotReject(
    () => readFile(join(dest, '.claude', 'commands', 'verify.md'), 'utf8'),
    '.claude/commands/verify.md missing — Claude Code will not expose /verify',
  );
});

test('AGENTS.md has every placeholder resolved', async () => {
  const dest = await render();
  const out = await readFile(join(dest, 'AGENTS.md'), 'utf8');
  const leftover = out.match(/__[A-Z_]+__/g);
  assert.equal(leftover, null, `unsubstituted tokens shipped to the user: ${leftover}`);
  assert.ok(out.includes('https://demo-site.test'), 'site URL rendered');
});

test('AGENTS.md stays lean — it is loaded into context every session', async () => {
  // Soft budget, deliberately enforced: this file is read on every single
  // session, so length is a real cost. Long procedures belong in a command
  // (loaded only when invoked), not here. If this fails, move something.
  const lines = (await read('template/AGENTS.md')).trim().split('\n').length;
  assert.ok(lines <= 45, `AGENTS.md is ${lines} lines; move a section into a command instead`);
});

test('verify.md keeps its {{PLACEHOLDER}} tokens — the agent fills those, not the template engine', async () => {
  const dest = await render();
  const out = await readFile(join(dest, '.claude', 'commands', 'verify.md'), 'utf8');
  for (const token of ['{{WP_VERSION}}', '{{PHP_VERSION}}', '{{OXYGEN_VERSION}}', '{{DATE}}']) {
    assert.ok(out.includes(token), `${token} was consumed by templating`);
  }
  assert.equal(out.match(/__[A-Z_]+__/g), null, 'no stray template tokens');
});

test('the holding page wordmark is an SVG, not font-dependent text', async () => {
  // Learned by looking at it: block art rendered as TEXT depends on the
  // viewer's monospace font drawing U+2588 at exactly the character advance.
  // With white-space:pre applied, a genuinely monospaced font, and all five
  // lines at the right lengths, the letters STILL ran together. An SVG has no
  // font dependency, so the page looks the same everywhere.
  const dest = await render();
  const verify = await readFile(join(dest, '.claude', 'commands', 'verify.md'), 'utf8');

  assert.ok(verify.includes('<svg'), 'wordmark should be an SVG');
  assert.equal(/█/.test(verify), false, 'block-character wordmark reintroduced — it will not render reliably');
});

test('the SVG wordmark still spells the same art as the CLI banner', async () => {
  // Rebuild the glyph grid from the path geometry and compare to the source
  // art, so the page and the terminal can never show different wordmarks.
  const CELL = 10;
  const ROW = 14;
  const verify = await read('template/.claude/commands/verify.md');
  const ansi = await read('src/ansi.mjs');

  const art = ansi.split('\n').filter((l) => l.includes('█')).map((l) => l.match(/'(.*)'/)[1]);
  const d = verify.match(/<path d="([^"]+)"/)?.[1];
  assert.ok(d, 'no path data found in the wordmark SVG');

  const cols = Math.max(...art.map((l) => l.length));
  const grid = Array.from({ length: art.length }, () => Array(cols).fill(' '));
  for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v\d+h-\d+z/g)) {
    const row = +y / ROW;
    const col = +x / CELL;
    for (let i = 0; i < +w / CELL; i++) grid[row][col + i] = '█';
  }

  const rebuilt = grid.map((r) => r.join('').replace(/\s+$/, ''));
  const source = art.map((l) => l.replace(/\s+$/, ''));
  assert.deepEqual(rebuilt, source, 'the SVG wordmark has drifted from src/ansi.mjs');
});

test('no frozen file tells the user to run `agentpress <cmd>`, which is not a command', async () => {
  // package.json ships ONE bin, `create-agentpress`. There is no `agentpress`
  // binary, and the decision was not to add an alias. Up to v1.7.1 five frozen
  // files said otherwise, including AGENTS.md and three places in verify.md, and
  // they said it at the 401 recovery moment — so an agent read the instruction,
  // PowerShell answered "The term 'agentpress' is not recognized", and because
  // the wrong form lived in agent-facing files the agent repeated and defended it.
  // Inside a site, `agentpress` is only an npm SCRIPT, i.e. `npm run agentpress`.
  const files = ['template/AGENTS.md', 'template/.claude/commands/verify.md', 'template/gitignore', 'template/README.md'];
  const bare = /(?<!create-)(?<!run )\bagentpress\s+(rewire|update|doctor|destroy|list|setup|resume)\b/;
  for (const file of files) {
    const text = await read(file);
    const offending = text
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => bare.test(line));
    assert.deepEqual(offending, [], `${file} must use \`npx create-agentpress@latest <cmd>\``);
  }
});

test('the CLI still declares exactly one bin, so the rule above stays true', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.deepEqual(Object.keys(pkg.bin), ['create-agentpress'], 'adding a bin alias means revisiting the templates');
});

test('verify.md tells agents not to name the screenshot, which --output-dir alone does not cover', async () => {
  // These two are one control in two files. `--output-dir` in src/mcp.mjs only
  // governs the DEFAULT filename: verified live by driving the server over
  // stdio, an explicit relative `filename` resolves against the agent's cwd and
  // escapes the output dir, dropping the PNG into the user's site folder. So
  // the flag without this instruction is half a fix, and either one deleted on
  // its own silently restores the bug.
  const out = await read('template/.claude/commands/verify.md');
  assert.match(out, /do\s+not\s+pass\s+a\s+`filename`/i, 'missing the instruction that keeps screenshots out of the project');

  const mcp = await read('src/mcp.mjs');
  assert.match(mcp, /'--output-dir'/, 'Playwright is no longer wired with an output directory');
});

test('verify.md drives the page tools with parameters they actually have', async () => {
  // create-post has no `slug` and search-posts cannot filter by one. Asking for
  // a slug-based lookup made an agent invent the parameter, and the call was
  // rejected — reported from the field after a real /verify run.
  // \s+ rather than a literal space throughout: this is wrapped prose, and a
  // test that fails when a paragraph is re-flowed teaches people to delete it.
  const out = await read('template/.claude/commands/verify.md');
  assert.match(out, /no\s+`slug`\s+parameter/i, 'must state that create-post takes no slug');
  assert.match(out, /cannot\s+filter\s+by\s+slug/i, 'must state that search-posts cannot look up by slug');
});

test('the page never claims success unconditionally', async () => {
  // The status card is evidence. A template that always renders "all checks
  // passed" would make it decoration, so the instructions must say otherwise.
  const out = await read('template/.claude/commands/verify.md');
  assert.match(out, /do not write `exit 0/i, 'missing the instruction not to fake a pass');
  assert.match(out, /stop at the first failure/i, 'missing the stop-on-failure rule');
});
