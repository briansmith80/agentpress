// Asserts the PUBLISHED payload, not the working tree. Run by CI and worth
// running by hand before a release.
//
// SECURITY.md once shipped missing entirely because package.json's `files`
// allowlist did not mention it, and nothing noticed until someone read the
// package page. A correct version number over a wrong payload looks identical
// from the outside.
//
// Not named *.test.mjs on purpose: it shells out to `npm pack`, which is far
// slower than the rest of the suite and needs no test runner.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const REQUIRED = [
  'index.js',
  'SECURITY.md',
  'src/engine.js',
  'src/mcp.mjs',
  'src/wordpress.mjs',
  'src/ansi.mjs',
  'template/scripts/agentpress.mjs',
  'template/sandbox.config.json',
  'template/wp-cli.yml',
];

// Anything that would be an embarrassment or a leak in a published package.
const FORBIDDEN = (path) => path.startsWith('test/') || path.startsWith('.github/') || path.endsWith('.diff') || path === 'HANDOFF.md';

const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: repoRoot, encoding: 'utf8', shell: true });
const files = JSON.parse(raw)[0].files.map((f) => f.path.split('\\').join('/'));

const missing = REQUIRED.filter((r) => !files.includes(r));
const leaked = files.filter(FORBIDDEN);

for (const m of missing) console.error(`MISSING from the tarball: ${m}`);
for (const l of leaked) console.error(`MUST NOT ship: ${l}`);

if (missing.length || leaked.length) {
  console.error(`\nFAILED: ${missing.length} missing, ${leaked.length} that should not ship.`);
  process.exit(1);
}
console.log(`tarball OK — ${files.length} files, all ${REQUIRED.length} required present, nothing leaked.`);
