// Behavioural tests for the MCP wiring code, against local HTTP servers and a
// redirected home directory. Still no Laragon, no WordPress, no network.
//
// These exist because both of these functions shipped broken inside a single
// release: verifyMcpEndpoint could hang a scaffold forever, and the config
// writer could delete every MCP server a user had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyMcpEndpoint, configureCursor, configureOpenCode, readWiredHostnames } from '../src/mcp.mjs';

const CREDS = { username: 'admin', password: 'pw-1234567890' };

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const urlFor = (port) => `http://127.0.0.1:${port}/wp-json/mcp/mcp-adapter-default-server`;

/** A well-behaved streamable-HTTP MCP server: issues a session, then lists tools. */
function healthyMcp(toolCount) {
  return (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const tools = Array.from({ length: toolCount }, (_, i) => ({ name: `tool-${i}` }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' });
      res.end(
        body.includes('"initialize"')
          ? JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })
          : JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } }),
      );
    });
  };
}

test('verifyMcpEndpoint confirms a healthy endpoint and counts its tools', async () => {
  const { server, port } = await serve(healthyMcp(5));
  try {
    const r = await verifyMcpEndpoint({ wpApiUrl: urlFor(port), ...CREDS, timeoutMs: 3000 });
    assert.equal(r.ok, true);
    assert.equal(r.tools, 5);
  } finally {
    server.close();
  }
});

test('verifyMcpEndpoint reports a rejected credential as such, not as a generic failure', async () => {
  const { server, port } = await serve((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"code":"rest_forbidden"}');
  });
  try {
    const r = await verifyMcpEndpoint({ wpApiUrl: urlFor(port), ...CREDS, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /credential/i);
  } finally {
    server.close();
  }
});

test('verifyMcpEndpoint fails cleanly when no MCP session is issued', async () => {
  const { server, port } = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); // no Mcp-Session-Id
    res.end('{}');
  });
  try {
    const r = await verifyMcpEndpoint({ wpApiUrl: urlFor(port), ...CREDS, timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /session/i);
  } finally {
    server.close();
  }
});

test('verifyMcpEndpoint rejects a malformed URL without throwing', async () => {
  const r = await verifyMcpEndpoint({ wpApiUrl: 'not a url', ...CREDS, timeoutMs: 500 });
  assert.equal(r.ok, false);
});

// REGRESSION, the important one. The first version settled only on res 'end',
// req 'timeout' and req 'error'. A peer closing AFTER headers emits none of
// those, so the promise never settled — and with nothing else holding the loop
// open the scaffold could exit(0) mid-run, having made the site but not its
// templates, registry entry or admin link, while reporting success.
for (const [label, handler] of [
  [
    'truncated Content-Length body',
    (req, res) => {
      res.writeHead(200, { 'Content-Length': '500', 'Mcp-Session-Id': 'a' });
      res.write('{"partial"');
      res.socket.destroy();
    },
  ],
  [
    'truncated chunked body',
    (req, res) => {
      res.writeHead(200, { 'Mcp-Session-Id': 'a' });
      res.write('{"partial"');
      res.socket.destroy();
    },
  ],
  ['reset before any headers', (req, res) => res.socket.destroy()],
  ['accepts but never responds', () => {}],
  ['headers only, socket held open', (req, res) => res.writeHead(200, { 'Mcp-Session-Id': 'a' })],
]) {
  test(`verifyMcpEndpoint settles (never hangs) when the peer ${label}`, async () => {
    const { server, port } = await serve(handler);
    try {
      const started = Date.now();
      const r = await Promise.race([
        verifyMcpEndpoint({ wpApiUrl: urlFor(port), ...CREDS, timeoutMs: 1500 }),
        new Promise((resolve) => setTimeout(() => resolve({ HUNG: true }), 8000)),
      ]);
      assert.equal(r.HUNG, undefined, 'the promise must settle');
      assert.equal(r.ok, false);
      assert.ok(Date.now() - started < 7000, 'must settle within the deadline');
    } finally {
      server.close();
    }
  });
}

/** Runs a body with HOME/USERPROFILE pointed at a throwaway directory. */
async function withFakeHome(run) {
  const home = await mkdtemp(join(tmpdir(), 'agentpress-test-'));
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    return await run(home);
  } finally {
    if (prevUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
}

test('configureCursor creates a config that does not exist yet', async () => {
  await withFakeHome(async (home) => {
    await configureCursor({ wpApiUrl: 'http://a.test/x', ...CREDS });
    const cfg = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.ok(cfg.mcpServers.wordpress);
    assert.ok(cfg.mcpServers.playwright);
  });
});

// REGRESSION: readJson mapped every failure to {}, so an unparseable config was
// replaced by one holding only our two servers — deleting everything the user
// had, with no backup.
test("configureCursor preserves the user's own servers and unrelated settings", async () => {
  await withFakeHome(async (home) => {
    const path = join(home, '.cursor', 'mcp.json');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { mine: { command: 'node' } }, editorSetting: 42 }), 'utf8');
    await configureCursor({ wpApiUrl: 'http://a.test/x', ...CREDS });
    const cfg = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(cfg.mcpServers.mine, "the user's own MCP server must survive");
    assert.equal(cfg.editorSetting, 42, 'unrelated settings must survive');
    assert.ok(cfg.mcpServers.wordpress);
  });
});

test('configureCursor REFUSES an unparseable config and leaves it byte-identical', async () => {
  await withFakeHome(async (home) => {
    const path = join(home, '.cursor', 'mcp.json');
    await mkdir(join(home, '.cursor'), { recursive: true });
    const original = '{\n  // a comment JSON.parse rejects\n  "mcpServers": {}\n}\n';
    await writeFile(path, original, 'utf8');
    await assert.rejects(() => configureCursor({ wpApiUrl: 'http://a.test/x', ...CREDS }), /refusing to rewrite/i);
    assert.equal(await readFile(path, 'utf8'), original, 'the file must not be touched');
  });
});

test('configureOpenCode applies the same protections', async () => {
  await withFakeHome(async (home) => {
    const path = join(home, '.config', 'opencode', 'opencode.json');
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(path, '{ not json }', 'utf8');
    await assert.rejects(() => configureOpenCode({ wpApiUrl: 'http://a.test/x', ...CREDS }), /refusing to rewrite/i);
    assert.equal(await readFile(path, 'utf8'), '{ not json }');
  });
});

test('config writes leave no temp files behind', async () => {
  await withFakeHome(async (home) => {
    await configureCursor({ wpApiUrl: 'http://a.test/x', ...CREDS });
    const entries = await (await import('node:fs/promises')).readdir(join(home, '.cursor'));
    assert.equal(entries.filter((f) => f.includes('agentpress-tmp')).length, 0);
  });
});

test('readWiredHostnames reports the site each readable agent config points at', async () => {
  await withFakeHome(async (home) => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { wordpress: { env: { WP_API_URL: 'http://alpha.test/wp-json/mcp/x' } } } }),
      'utf8',
    );
    const wired = await readWiredHostnames();
    assert.equal(wired.claude, 'alpha.test');
    assert.equal(wired.cursor, undefined, 'an absent config is not reported at all');
  });
});
