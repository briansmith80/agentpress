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

test('the holding page wordmark matches the CLI banner and survives templating', async () => {
  // Same art in a third place now (src/ansi.mjs, the frozen menu, and here).
  // The page is a regression test, so a drifted wordmark is a real defect.
  const dest = await render();
  const verify = await readFile(join(dest, '.claude', 'commands', 'verify.md'), 'utf8');
  const ansi = await read('src/ansi.mjs');

  // Extract exactly, never trim: the first art line begins with a significant
  // space, and trimming it away would let a real one-column drift pass.
  const fromCli = ansi
    .split('\n')
    .filter((l) => l.includes('█'))
    .map((l) => l.match(/'(.*)'/)[1]);

  const fromPage = verify
    .split('\n')
    .filter((l) => l.includes('█'))
    .map((l) => l.replace(/^<div class="ap-mark">/, '').replace(/<\/div>$/, ''));

  assert.equal(fromPage.length, 5, `wordmark must be 5 lines, got ${fromPage.length}`);
  assert.deepEqual(fromPage, fromCli, 'holding-page wordmark has drifted from src/ansi.mjs');
});

test('the page never claims success unconditionally', async () => {
  // The status card is evidence. A template that always renders "all checks
  // passed" would make it decoration, so the instructions must say otherwise.
  const out = await read('template/.claude/commands/verify.md');
  assert.match(out, /do not write `exit 0/i, 'missing the instruction not to fake a pass');
  assert.match(out, /stop at the first failure/i, 'missing the stop-on-failure rule');
});
