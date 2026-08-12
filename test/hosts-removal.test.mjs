// The elevated script that edits the machine's hosts file. This one gets a real
// PowerShell run against a temp file rather than a string comparison, because the
// blast radius is a system file every process on the box resolves through, and this
// project has been burned repeatedly by logic that read correctly and behaved
// differently.
//
// `hostsRemovalScript` exists as a pure function precisely so the SHIPPED text is what
// runs here. Testing a transcribed copy would prove nothing.
//
// PowerShell is present on the CI runner (windows-latest), the same reason the rest of
// the suite can assume Windows. No elevation is needed: the script only needs write
// access to whatever `$hosts` points at, and here that is a temp file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostsRemovalScript } from '../src/wildcard.mjs';
import { psCapture } from '../src/win.mjs';

/** Runs the real script over `lines`, returning what survived plus the exit code. */
async function filter(lines, hostname = 'mysite.test') {
  const dir = await mkdtemp(join(tmpdir(), 'ap-hosts-'));
  const hosts = join(dir, 'hosts');
  const script = join(dir, 'rm.ps1');
  await writeFile(hosts, `${lines.join('\r\n')}\r\n`, 'utf8');
  await writeFile(script, hostsRemovalScript(hostname, '$args[0]'), 'utf8');
  const { code } = await psCapture(`& '${script}' '${hosts}'; exit $LASTEXITCODE`);
  const after = (await readFile(hosts, 'utf8')).split(/\r?\n/).filter((l) => l !== '');
  return { after, code };
}

test('removes only the lines that are solely about this host', async () => {
  const { after } = await filter([
    '# Copyright (c) 1993-2009 Microsoft Corp.',
    '127.0.0.1  mysite.test  #agentpress',
    '127.0.0.1  mysite.test  #laragon magic!',
    '::1  mysite.test',
    '127.0.0.1  MYSITE.TEST',
  ]);
  assert.deepEqual(after, ['# Copyright (c) 1993-2009 Microsoft Corp.'], 'all four host lines should go, whatever their tag, address or case');
});

test('never touches a line it does not exclusively own', async () => {
  // Each of these has bitten a hosts implementation somewhere. The shared line is the
  // important one: removing it would silently break a host the user still wants.
  const keep = [
    '127.0.0.1  other.test  #agentpress',
    '127.0.0.1  mysite.test  extra.test  #shared line',
    '# 127.0.0.1  mysite.test  (commented out)',
    '127.0.0.1  notmysite.test',
    '127.0.0.1  mysite.test.uk',
    '10.0.0.5  intranet.local',
  ];
  const { after } = await filter(keep);
  assert.deepEqual(after, keep, 'nothing here is exclusively mysite.test');
});

test('does not rewrite the file at all when nothing matches', async () => {
  // exit 0 without a write. Rewriting a system file for no reason is its own risk:
  // it would rewrite line endings and encoding on every no-op destroy.
  const { code } = await filter(['127.0.0.1  other.test', '# comment']);
  assert.equal(code, 0);
});

test('refuses to blank the file rather than emptying it', async () => {
  // The guard that matters most. An earlier draft used `-ErrorAction SilentlyContinue`
  // on the read, so a locked hosts file would have produced an empty $kept and
  // Set-Content would have wiped every entry on the machine.
  const { after, code } = await filter(['127.0.0.1  mysite.test']);
  assert.equal(code, 4, 'must exit 4 rather than write an empty file');
  assert.deepEqual(after, ['127.0.0.1  mysite.test'], 'and must leave the file untouched');
});

test('the script never falls back to a substring match', async () => {
  // Pinned as text as well as behaviour: `-match`/`-like`/`.Contains` on the raw line
  // is exactly the bug ensureHostsEntry documents, where "blog" matched "myblog.test".
  const script = hostsRemovalScript('mysite.test');
  assert.match(script, /\$tokens\.Count -eq 2 -and \$tokens\[1\] -eq \$name/);
  assert.doesNotMatch(script, /-match|-like|\.Contains\(/);
  assert.match(script, /-ErrorAction Stop/, 'a silent read failure must never reach Set-Content');
});
