// Generates docs/hero.svg — the README's animated demo of a scaffold run.
//
//   node tools/hero.mjs
//
// An animated SVG instead of a screen-recorded GIF, deliberately: GitHub and
// npm render it inline, CSS animations play inside an <img>, text stays
// vector-crisp, and the whole loop weighs kilobytes. Above all it is a BUILD
// ARTIFACT: the wordmark comes from src/ansi.mjs's BANNER_LINES exactly like
// tools/wordmark.mjs, and every line of "output" is the tool's real string,
// so the demo cannot quietly drift from the product the way a stale GIF does.
// Regenerate after output changes worth showing off.
//
// The wordmark is geometry (merged rect runs), never <text> — SVG text
// depends on the viewer's monospace glyph widths matching the character
// advance, which was tested and found false (see tools/wordmark.mjs). The
// terminal lines ARE text, but nothing in them depends on cross-line column
// alignment except the panel labels, which use fixed x offsets instead.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repo = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const art = (await readFile(repo('src/ansi.mjs'), 'utf8'))
  .split('\n')
  .filter((l) => l.includes('█'))
  .map((l) => l.match(/'(.*)'/)[1]);
if (art.length !== 5) throw new Error(`expected 5 art rows in src/ansi.mjs, found ${art.length}`);

const version = JSON.parse(await readFile(repo('package.json'), 'utf8')).version;

// The /verify holding page's palette — the brand's established dark set.
const C = {
  bg: '#0b0d11',
  border: '#262b34',
  text: '#d8dbe2',
  dim: '#8890a0',
  pink: '#ff2d78',
  green: '#4fbf6d',
  cyan: '#4fc3e8',
};

const FONT = "font-family=\"'Cascadia Mono', Consolas, 'Courier New', monospace\" font-size=\"15\"";
const X = 36;
const LINE = 23;

/** Merged horizontal runs of the block art, as rects (same approach as wordmark.mjs). */
function wordmarkRects(cell, rowH, ox, oy) {
  const out = [];
  art.forEach((line, y) => {
    let n = 0;
    for (let x = 0; x <= line.length; x++) {
      if (line[x] === '█') {
        n++;
        continue;
      }
      if (n > 0) {
        out.push(`<rect x="${ox + (x - n) * cell}" y="${oy + y * rowH}" width="${n * cell}" height="${rowH - 1.5}" fill="${C.pink}"/>`);
        n = 0;
      }
    }
  });
  return out.join('');
}

// --- the storyboard -------------------------------------------------------
// One 26-second loop. Every element declares when it appears and (optionally)
// when its scene leaves; the generator turns that into per-element keyframes.
// All strings below are the tool's real output shapes.
const T = 26; // seconds
let kfId = 0;
const keyframes = [];
/** Visibility window in % of the loop, with short fades at both edges. */
function vis(showPct, hidePct = 96) {
  const id = `k${kfId++}`;
  const fadeIn = 1.2;
  const fadeOut = 2;
  keyframes.push(
    `@keyframes ${id}{0%,${showPct}%{opacity:0}${Math.min(showPct + fadeIn, 100)}%,${hidePct}%{opacity:1}${Math.min(hidePct + fadeOut, 100)}%,100%{opacity:0}}`,
  );
  return `style="opacity:0;animation:${id} ${T}s linear infinite"`;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, fill, content, extra = '') => `<text x="${x}" y="${y}" fill="${fill}" ${FONT} ${extra}>${content}</text>`;
const t = (s, fill = C.text) => `<tspan fill="${fill}">${esc(s)}</tspan>`;

const parts = [];

// Scene 1: the typed command (visible only at the start of the loop).
{
  const y = 64;
  parts.push(
    `<g ${vis(1, 12)}>` +
      text(X, y, C.dim, t('PS C:\\> ', C.dim) + t('npx create-agentpress@latest my-site', C.text)) +
      `</g>`,
  );
}

// Scene 2: banner, confirm, step lines. Enters as the "run" starts.
{
  const oy = 92;
  parts.push(`<g ${vis(13, 54)}>${wordmarkRects(7.2, 13, X, oy)}${text(X + 160, oy + 84, C.dim, t(`v${version} · AI-agent-ready WordPress`, C.dim))}</g>`);
  const lines = [
    [20, t('? ', C.pink) + t('Scaffold a new WordPress site "', C.text) + t('my-site', C.pink) + t('" at http://my-site.test? [y/N]: ', C.text) + t('y', C.text)],
    [24, t('→ ', C.cyan) + t('Staging my-site …', C.text)],
    [27, t('✓ ', C.green) + t('Project created at C:\\laragon\\www\\my-site', C.text)],
    [30, t('→ ', C.cyan) + t('Instant mode: no Laragon reload needed.', C.text)],
    [33, t('✓ ', C.green) + t('hosts entry added', C.text)],
    [36, t('→ ', C.cyan) + t('Creating database…', C.text)],
    [39, t('✓ ', C.green) + t('Database my_site + user my_site ready', C.text)],
    [42, t('  … ', C.dim) + t('installing WordPress core…', C.dim)],
    [45, t('  … ', C.dim) + t('wiring MCP for claude…', C.dim)],
    [48, t('  … ', C.dim) + t('MCP endpoint answered (39 tools)', C.dim)],
  ];
  let y = 214;
  for (const [at, content] of lines) {
    parts.push(`<g ${vis(at, 54)}>${text(X, y, C.text, content)}</g>`);
    y += LINE;
  }
}

// Scene 3: the final panel, held long enough to read.
{
  const rows = [];
  let y = 74;
  const row = (at, content) => {
    parts.push(`<g ${vis(at)}>${text(X, y, C.text, content)}</g>`);
    y += LINE;
  };
  const label = (at, name, value, valueFill = C.text) => {
    parts.push(`<g ${vis(at)}>${text(X + 14, y, C.dim, t(name, C.dim))}${text(X + 96, y, valueFill, t(value, valueFill))}</g>`);
    y += LINE;
  };
  row(57, t('✓ ', C.green) + t('WordPress is ready.', C.text));
  row(59, t('✓ ', C.green) + t('MCP wired for: claude (verified, 39 tools)', C.text));
  parts.push(`<g ${vis(61)}>${text(X + 14, y, C.dim, t('Claude Code is wired per-site (.mcp.json): approve once on first launch.', C.dim))}</g>`);
  y += LINE * 1.5;
  label(63, 'Site', 'https://my-site.test');
  label(65, 'Admin', 'https://my-site.test/?acfw_login=… (one-click)');
  label(67, 'User', 'admin');
  label(69, 'Pass', 'wp-....-....');
  y += LINE * 0.5;
  row(72, t('cd C:\\laragon\\www\\my-site', C.pink));
  row(74, t('npm run agentpress', C.pink) + t('   # open the menu', C.dim));
  y += LINE * 0.5;
  row(78, t('Then open this folder in Claude Code and run ', C.text) + t('/verify', C.pink));
  void rows;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 520" role="img" aria-label="create-agentpress scaffolding a WordPress site: one command, wordmark, live steps, then URLs and MCP wiring">
  <style>text{white-space:pre}${keyframes.join('')}</style>
  <rect x="1" y="1" width="858" height="518" rx="12" fill="${C.bg}" stroke="${C.border}" stroke-width="2"/>
  <circle cx="26" cy="24" r="5" fill="${C.border}"/><circle cx="44" cy="24" r="5" fill="${C.border}"/><circle cx="62" cy="24" r="5" fill="${C.border}"/>
  ${parts.join('\n  ')}
</svg>
`;

await mkdir(repo('docs'), { recursive: true });
await writeFile(repo('docs/hero.svg'), svg, 'utf8');
console.log(`docs/hero.svg written (${Buffer.byteLength(svg)} bytes, ${kfId} animated elements, ${T}s loop)`);
