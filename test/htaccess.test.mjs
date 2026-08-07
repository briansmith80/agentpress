// The .htaccess block AgentPress owns, and the repair path `rewire` runs before
// it mints a credential.
//
// The first two tests are the load-bearing ones. WordPress detects its own
// markers with str_contains() on each LINE, not an anchored compare, so ANY
// occurrence of that text in our block — including inside a comment — is read
// as WordPress's opening marker on the next hard rewrite flush. v1.7.0 shipped
// exactly that mistake into a working tree and it swallowed half the file; only
// a real flush against a real site showed it, because nothing about the source
// looked wrong. These pin it so the next person editing that comment finds out
// in 15ms instead of on a user's site.
//
// No Laragon and no WordPress needed — this is string work plus temp files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTACCESS_AUTH_MARKER, HTACCESS_GUARD_BLOCK, ensureHtaccessGuardBlock } from '../src/wordpress.mjs';

// Assembled rather than written literally, so this file does not contain the
// string it is asserting the absence of.
const WP_BEGIN = `# ${'BEGIN'} WordPress`;
const WP_END = `# ${'END'} WordPress`;

/** The stock WordPress block, as core regenerates it on a hard flush. */
const WP_BLOCK = `${WP_BEGIN}
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
${WP_END}
`;

async function sitePublic(htaccess) {
  const root = await mkdtemp(join(tmpdir(), 'ap-htaccess-'));
  const publicDir = join(root, 'public');
  await mkdir(publicDir, { recursive: true });
  if (htaccess !== null) await writeFile(join(publicDir, '.htaccess'), htaccess, 'utf8');
  return publicDir;
}

test('the guard block ships the Application Password passthrough', () => {
  assert.ok(
    HTACCESS_GUARD_BLOCK.includes(HTACCESS_AUTH_MARKER),
    'without this rule Apache strips the Authorization header and every application password 401s',
  );
});

test("the guard block never contains WordPress's marker text (v1.7.0 shipped this and it ate the file)", () => {
  assert.ok(!HTACCESS_GUARD_BLOCK.includes(WP_BEGIN), 'core would treat that line as its own opening marker');
  assert.ok(!HTACCESS_GUARD_BLOCK.includes(WP_END), 'core would treat that line as its own closing marker');
});

test('ensureHtaccessGuardBlock restores a stripped passthrough and reports it', async () => {
  // A file some third party rewrote without the rule — the one state that
  // actually produces the 401, since core supplies its own copy otherwise.
  const publicDir = await sitePublic(WP_BLOCK);
  const result = await ensureHtaccessGuardBlock(publicDir);
  const after = await readFile(join(publicDir, '.htaccess'), 'utf8');

  assert.equal(result.restoredAuth, true, 'rewire prints its repair line off this flag');
  assert.ok(after.includes(HTACCESS_AUTH_MARKER));
  // Prepended, so the guard is evaluated before WordPress hands off to index.php.
  assert.ok(after.indexOf('# BEGIN AgentPress') < after.indexOf(WP_BEGIN));
  assert.ok(after.includes(WP_BLOCK.trim()), "WordPress's own block must be left intact");
});

test('ensureHtaccessGuardBlock is idempotent, so rewire can run it unconditionally', async () => {
  const publicDir = await sitePublic(WP_BLOCK);
  await ensureHtaccessGuardBlock(publicDir);
  const second = await ensureHtaccessGuardBlock(publicDir);

  assert.equal(second.changed, false);
  assert.equal(second.restoredAuth, false, 'a healthy site must not claim a repair it did not make');
});

test('ensureHtaccessGuardBlock replaces our block in place rather than stacking copies', async () => {
  const publicDir = await sitePublic(WP_BLOCK);
  await ensureHtaccessGuardBlock(publicDir);
  await ensureHtaccessGuardBlock(publicDir);
  const after = await readFile(join(publicDir, '.htaccess'), 'utf8');

  assert.equal(after.split('# BEGIN AgentPress').length - 1, 1);
  assert.equal(after.split(WP_BEGIN).length - 1, 1);
});
