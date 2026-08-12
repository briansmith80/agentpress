// Runs the REAL elevated-script bytes (hostsRemovalScript / hostsAppendScript)
// through real PowerShell against temp files — unelevated, no system file in
// reach. This suite exists because of 2026-08-12: the first hosts-removal
// left the machine's hosts file EMPTY. Mechanism: `Get-Content -ErrorAction
// SilentlyContinue` returns nothing on a failed read, the filter over zero
// lines produced an empty result, and Set-Content persisted it. The tests
// named "regression:" below each pin one guard that makes that impossible;
// if a refactor reintroduces the silent-empty-write shape, they fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentpressHostsMatches, hostsAppendScript, hostsRemovalScript } from '../src/wildcard.mjs';
import { PS_EXE } from '../src/paths.mjs';

const CRLF = '\r\n';

function runScript(script) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-hosts-test-'));
  const file = join(dir, 'script.ps1');
  writeFileSync(file, script, 'utf8');
  try {
    const r = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { code: r.status, stderr: r.stderr || '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A temp stand-in hosts file; returns its path inside a fresh directory the test cleans up. */
function tempHosts(content) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-hosts-fixture-'));
  const file = join(dir, 'hosts');
  if (content !== null) writeFileSync(file, content, 'utf8');
  return { dir, file };
}

// Mirrors the real file's observed shape: the blank line the old append
// prefix left above every #agentpress entry, Laragon's own aligned block,
// and every trap the matcher must NOT touch.
const FIXTURE = [
  '',
  '',
  '127.0.0.1\tstale1.test\t#agentpress',
  '',
  '127.0.0.1\tstale2.test\t#agentpress',
  '::1\tstale2.test\t#agentpress',
  '127.0.0.1      keepme.test          #laragon magic!   ',
  '127.0.0.1      stale1.test          #laragon magic!   ', // same hostname, NOT our tag
  '# a comment mentioning stale1.test stays',
  '10.0.0.5\tstale1.test\t#agentpress', // our tag but not loopback: not ours
  '127.0.0.1\tnotstale1.test\t#agentpress', // substring trap (prefix)
  '127.0.0.1\tstale1.test.uk\t#agentpress', // substring trap (suffix)
  '127.0.0.1 multi.test stale1.test #agentpress', // multi-host line: we never write these
  '127.0.0.1\tsurvivor.test\t#agentpress',
  '',
].join(CRLF);

test('removes only our tagged entries, collapses their blank lines, leaves every trap byte-identical', () => {
  const { dir, file } = tempHosts(FIXTURE);
  try {
    const code = runScript(hostsRemovalScript(['stale1.test', 'stale2.test'], { hostsPath: file, maxRemove: 6 })).code;
    assert.equal(code, 0);
    // Each removed entry also takes the nearest blank line above it (the old
    // append prefix's artifact) — with three entries removed here, all three
    // blanks go, including both leading ones. Only whitespace lines are ever
    // taken this way, and $maxRemove counts them.
    const expected = [
      '127.0.0.1      keepme.test          #laragon magic!   ',
      '127.0.0.1      stale1.test          #laragon magic!   ',
      '# a comment mentioning stale1.test stays',
      '10.0.0.5\tstale1.test\t#agentpress',
      '127.0.0.1\tnotstale1.test\t#agentpress',
      '127.0.0.1\tstale1.test.uk\t#agentpress',
      '127.0.0.1 multi.test stale1.test #agentpress',
      '127.0.0.1\tsurvivor.test\t#agentpress',
      '',
    ].join(CRLF);
    assert.equal(readFileSync(file, 'utf8'), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the JS matcher and the PowerShell filter agree on what is ours', () => {
  // Parity is the invariant, not either side alone: the last time two hosts
  // presence checks drifted, one skipped a write the other reported done.
  const matches = agentpressHostsMatches(FIXTURE, ['stale1.test', 'stale2.test']);
  assert.deepEqual(matches, [
    '127.0.0.1\tstale1.test\t#agentpress',
    '127.0.0.1\tstale2.test\t#agentpress',
    '::1\tstale2.test\t#agentpress',
  ]);
});

test('exit 10 and no write when the hostname only appears in lines that are not ours', () => {
  const { dir, file } = tempHosts(FIXTURE);
  try {
    const code = runScript(hostsRemovalScript(['keepme.test'], { hostsPath: file, maxRemove: 2 })).code;
    assert.equal(code, 10);
    assert.equal(readFileSync(file, 'utf8'), FIXTURE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: an EMPTY hosts file is exit 12 and is never written to', () => {
  const { dir, file } = tempHosts('');
  try {
    const code = runScript(hostsRemovalScript(['stale1.test'], { hostsPath: file, maxRemove: 2 })).code;
    assert.equal(code, 12);
    assert.equal(readFileSync(file, 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: a whitespace-only hosts file is exit 12, unchanged', () => {
  const raw = `${CRLF}${CRLF}  ${CRLF}`;
  const { dir, file } = tempHosts(raw);
  try {
    const code = runScript(hostsRemovalScript(['stale1.test'], { hostsPath: file, maxRemove: 2 })).code;
    assert.equal(code, 12);
    assert.equal(readFileSync(file, 'utf8'), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: an unreadable hosts file is exit 11 — a failed read is loud, never an empty write', () => {
  const { dir, file } = tempHosts(null); // path exists as a name only; ReadAllText throws
  try {
    const code = runScript(hostsRemovalScript(['stale1.test'], { hostsPath: file, maxRemove: 2 })).code;
    assert.equal(code, 11);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: removing more lines than maxRemove allows is exit 13, unchanged', () => {
  const { dir, file } = tempHosts(FIXTURE);
  try {
    // stale1 + stale2 legitimately remove 6 lines (3 entries + 3 blanks); cap at 2.
    const code = runScript(hostsRemovalScript(['stale1.test', 'stale2.test'], { hostsPath: file, maxRemove: 2 })).code;
    assert.equal(code, 13);
    assert.equal(readFileSync(file, 'utf8'), FIXTURE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('regression: a file that is nothing but our entries is exit 13 — the result may never be empty', () => {
  const raw = `127.0.0.1\tonly.test\t#agentpress${CRLF}`;
  const { dir, file } = tempHosts(raw);
  try {
    const code = runScript(hostsRemovalScript(['only.test'], { hostsPath: file, maxRemove: 4 })).code;
    assert.equal(code, 13);
    assert.equal(readFileSync(file, 'utf8'), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file without a trailing newline keeps not having one', () => {
  const raw = `127.0.0.1\tgone.test\t#agentpress${CRLF}127.0.0.1\tlast.test\t#laragon magic!`;
  const { dir, file } = tempHosts(raw);
  try {
    const code = runScript(hostsRemovalScript(['gone.test'], { hostsPath: file, maxRemove: 2 })).code;
    assert.equal(code, 0);
    assert.equal(readFileSync(file, 'utf8'), '127.0.0.1\tlast.test\t#laragon magic!');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append: a file already ending in a newline gets NO blank line above the new entry', () => {
  const raw = `127.0.0.1\texisting.test\t#laragon magic!${CRLF}`;
  const { dir, file } = tempHosts(raw);
  try {
    const code = runScript(hostsAppendScript('fresh.test', { hostsPath: file })).code;
    assert.equal(code, 0);
    assert.equal(readFileSync(file, 'utf8'), `${raw}127.0.0.1\tfresh.test\t#agentpress${CRLF}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append: a file NOT ending in a newline gets a separator, never a glued line', () => {
  const raw = '127.0.0.1\texisting.test\t#laragon magic!';
  const { dir, file } = tempHosts(raw);
  try {
    const code = runScript(hostsAppendScript('fresh.test', { hostsPath: file })).code;
    assert.equal(code, 0);
    assert.equal(readFileSync(file, 'utf8'), `${raw}${CRLF}127.0.0.1\tfresh.test\t#agentpress${CRLF}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append then remove round-trips the file byte-identically', () => {
  const { dir, file } = tempHosts(FIXTURE);
  try {
    assert.equal(runScript(hostsAppendScript('roundtrip.test', { hostsPath: file })).code, 0);
    assert.notEqual(readFileSync(file, 'utf8'), FIXTURE);
    assert.equal(runScript(hostsRemovalScript(['roundtrip.test'], { hostsPath: file, maxRemove: 2 })).code, 0);
    assert.equal(readFileSync(file, 'utf8'), FIXTURE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('append: an already-present hostname is not appended twice', () => {
  const raw = `127.0.0.1\tdupe.test\t#agentpress${CRLF}`;
  const { dir, file } = tempHosts(raw);
  try {
    const code = runScript(hostsAppendScript('dupe.test', { hostsPath: file })).code;
    assert.equal(code, 0);
    assert.equal(readFileSync(file, 'utf8'), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
