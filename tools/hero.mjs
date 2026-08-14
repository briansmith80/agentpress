// Generates the README's animated demos:
//
//   node tools/hero.mjs
//     -> docs/hero.svg   (a scaffold run: command, wordmark, steps, panel)
//     -> docs/menu.svg   (the site menu: selection walk, snapshot, receipt)
//
// Animated SVGs instead of screen-recorded GIFs, deliberately: GitHub and npm
// render them inline, CSS animations play inside an <img>, text stays
// vector-crisp, and each loop weighs kilobytes. Above all they are BUILD
// ARTIFACTS: the wordmark comes from src/ansi.mjs's BANNER_LINES exactly like
// tools/wordmark.mjs, and every line of "output" is the tool's real string,
// so the demos cannot quietly drift from the product the way a stale GIF
// does. Regenerate after output changes worth showing off.
//
// Privacy property (operator's explicit instruction): nothing here is
// captured from a real screen. Site names are synthetic, passwords masked,
// tokens elided — personal tools and machine details cannot leak into a
// published asset, by construction.
//
// The wordmark is geometry (merged rect runs), never <text> — SVG text
// depends on the viewer's monospace glyph widths matching the character
// advance, which was tested and found false (see tools/wordmark.mjs). The
// terminal lines ARE text, but nothing in them depends on cross-line column
// alignment except label/value pairs, which use fixed x offsets instead.
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
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const t = (s, fill = C.text) => `<tspan fill="${fill}">${esc(s)}</tspan>`;

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

/**
 * One SVG document with its own keyframe namespace. Elements declare
 * visibility as % windows of the loop; the doc turns each into a dedicated
 * keyframe rule (multiple windows supported, for a row that is "plain except
 * while the selection cursor sits on it").
 */
function makeDoc({ width, height, seconds, label }) {
  let kfId = 0;
  const keyframes = [];
  const parts = [];
  const vis = (ranges, { snap = false } = {}) => {
    const id = `k${label}${kfId++}`;
    // Snap for selection cursors: a real menu cursor jumps between rows, and
    // crossfading adjacent windows painted TWO pink rows at once at the seam
    // (caught in browser verification).
    const fadeIn = snap ? 0.15 : 1.2;
    const fadeOut = snap ? 0.15 : 1.6;
    const spans = (Array.isArray(ranges[0]) ? ranges : [ranges])
      .map(([a, b]) => `${Math.min(a + fadeIn, 100)}%,${b}%{opacity:1}${Math.min(b + fadeOut, 100)}%{opacity:0}`)
      .join('');
    const hidden = (Array.isArray(ranges[0]) ? ranges : [ranges]).map(([a]) => `${a}%`).join(',');
    keyframes.push(`@keyframes ${id}{0%,${hidden}{opacity:0}${spans}100%{opacity:0}}`);
    return `style="opacity:0;animation:${id} ${seconds}s linear infinite"`;
  };
  const text = (x, y, content, visibility) => parts.push(`<g ${visibility}><text x="${x}" y="${y}" ${FONT}>${content}</text></g>`);
  const raw = (markup, visibility) => parts.push(`<g ${visibility}>${markup}</g>`);
  const render = (ariaLabel) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}">
  <style>text{white-space:pre}${keyframes.join('')}</style>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="12" fill="${C.bg}" stroke="${C.border}" stroke-width="2"/>
  <circle cx="26" cy="24" r="5" fill="${C.border}"/><circle cx="44" cy="24" r="5" fill="${C.border}"/><circle cx="62" cy="24" r="5" fill="${C.border}"/>
  ${parts.join('\n  ')}
</svg>
`;
  return { vis, text, raw, render };
}

// --- docs/hero.svg: the scaffold run -----------------------------------------
{
  const X = 36;
  const LINE = 23;
  const doc = makeDoc({ width: 860, height: 520, seconds: 26, label: 'h' });

  doc.text(X, 64, t('PS C:\\> ', C.dim) + t('npx create-agentpress@latest my-site'), doc.vis([1, 12]));

  doc.raw(wordmarkRects(7.2, 13, X, 92) + `<text x="${X + 160}" y="176" ${FONT}>${t(`v${version} · AI-agent-ready WordPress`, C.dim)}</text>`, doc.vis([13, 54]));
  const steps = [
    [20, t('? ', C.pink) + t('Scaffold a new WordPress site "') + t('my-site', C.pink) + t('" at http://my-site.test? [y/N]: ') + t('y')],
    [24, t('→ ', C.cyan) + t('Staging my-site …')],
    [27, t('✓ ', C.green) + t('Project created at C:\\laragon\\www\\my-site')],
    [30, t('→ ', C.cyan) + t('Instant mode: no Laragon reload needed.')],
    [33, t('✓ ', C.green) + t('hosts entry added')],
    [36, t('→ ', C.cyan) + t('Creating database…')],
    [39, t('✓ ', C.green) + t('Database my_site + user my_site ready')],
    [42, t('  … installing WordPress core…', C.dim)],
    [45, t('  … wiring MCP for claude…', C.dim)],
    [48, t('  … MCP endpoint answered (39 tools)', C.dim)],
  ];
  let y = 214;
  for (const [at, content] of steps) {
    doc.text(X, y, content, doc.vis([at, 54]));
    y += LINE;
  }

  y = 74;
  const row = (at, content) => {
    doc.text(X, y, content, doc.vis([at, 96]));
    y += LINE;
  };
  const label = (at, name, value, fill = C.text) => {
    doc.raw(`<text x="${X + 14}" y="${y}" ${FONT}>${t(name, C.dim)}</text><text x="${X + 96}" y="${y}" ${FONT}>${t(value, fill)}</text>`, doc.vis([at, 96]));
    y += LINE;
  };
  row(57, t('✓ ', C.green) + t('WordPress is ready.'));
  row(59, t('✓ ', C.green) + t('MCP wired for: claude (verified, 39 tools)'));
  row(61, t('  Claude Code is wired per-site (.mcp.json): approve once on first launch.', C.dim));
  y += LINE * 0.5;
  label(63, 'Site', 'https://my-site.test');
  label(65, 'Admin', 'https://my-site.test/?acfw_login=… (one-click)');
  label(67, 'User', 'admin');
  label(69, 'Pass', 'wp-....-....');
  y += LINE * 0.5;
  row(72, t('cd C:\\laragon\\www\\my-site', C.pink));
  row(74, t('npm run agentpress', C.pink) + t('   # open the menu', C.dim));
  y += LINE * 0.5;
  row(78, t('Then open this folder in Claude Code and run ') + t('/verify', C.pink));

  await mkdir(repo('docs'), { recursive: true });
  const svg = doc.render('create-agentpress scaffolding a WordPress site: one command, wordmark, live steps, then URLs and MCP wiring');
  await writeFile(repo('docs/hero.svg'), svg, 'utf8');
  console.log(`docs/hero.svg written (${Buffer.byteLength(svg)} bytes)`);
}

// --- docs/menu.svg: the site menu ---------------------------------------------
{
  const X = 36;
  const LINE = 23;
  const doc = makeDoc({ width: 860, height: 470, seconds: 18, label: 'm' });

  // Like the hero: open with the command that gets you here, then the menu.
  doc.text(X, 64, t('PS C:\\laragon\\www\\my-site> ', C.dim) + t('npm run agentpress'), doc.vis([1, 8]));

  // The credential header the real menu prints (URLs are links, i.e. pink).
  let y = 64;
  const header = [
    ['WordPress', 'https://my-site.test', C.pink],
    ['Admin', 'https://my-site.test/wp-admin', C.pink],
    ['Username', 'admin', C.text],
    ['Password', 'wp-....-....', C.text],
  ];
  for (const [name, value, fill] of header) {
    doc.raw(`<text x="${X}" y="${y}" ${FONT}>${t(name)}</text><text x="${X + 110}" y="${y}" ${FONT}>${t(value, fill)}</text>`, doc.vis([10, 96]));
    y += LINE;
  }
  y += LINE * 0.5;
  doc.text(X, y, t('? ', C.pink) + t('What would you like to do?'), doc.vis([[12, 50]]));
  const questionY = y;
  y += LINE * 1.2;

  // The real option list, hints included (all rows show their hint, dim).
  const items = [
    ['Open WP Admin', 'one-click login'],
    ['Open the site', 'front end'],
    ['Open Claude Code', 'MCP points here'],
    ['Snapshot the database', 'rollback point before agent sessions'],
    ['Restore the latest snapshot', 'db-2026-08-14T09-12-44Z.sql'],
    ['Show recent errors', 'debug on — nothing logged yet'],
    ['Open in VS Code', 'this site folder'],
    ['Open a terminal here', ''],
    ['Exit', ''],
  ];
  // The selection cursor walks from the first row down to Snapshot, pauses,
  // then "Enter": windows per row, in % of the 18s loop.
  const sel = [
    [14, 22],
    [22, 30],
    [30, 38],
    [38, 50],
  ];
  items.forEach(([labelText, hint], i) => {
    const rowY = y + i * LINE;
    const hintPart = hint ? t('  ' + hint, C.dim) : '';
    if (i < sel.length) {
      // Plain except while the cursor sits on it; the pink overlay covers that window.
      const [a, b] = sel[i];
      doc.text(X, rowY, t('  ') + t(labelText) + hintPart, doc.vis([[12, a], [b, 50]], { snap: true }));
      doc.text(X, rowY, t('> ', C.pink) + t(labelText, C.pink) + hintPart, doc.vis([a, b], { snap: true }));
    } else {
      doc.text(X, rowY, t('  ') + t(labelText) + hintPart, doc.vis([12, 50], { snap: true }));
    }
  });

  // Enter: the menu collapses to question › answer, then the receipt.
  doc.text(X, questionY, t('? ', C.pink) + t('What would you like to do? ') + t('› ', C.dim) + t('Snapshot the database'), doc.vis([52, 96]));
  doc.text(X, questionY + LINE * 1.2, t('  → database saved to snapshots\\db-2026-08-14T09-12-44Z.sql (2.6 MB)', C.dim), doc.vis([57, 96]));
  doc.text(X, questionY + LINE * 2.6, t('? ', C.pink) + t('What would you like to do?'), doc.vis([62, 96]));
  doc.text(X, questionY + LINE * 3.8, t('> ', C.pink) + t('Open WP Admin', C.pink) + t('  one-click login', C.dim), doc.vis([64, 96]));
  doc.text(X, questionY + LINE * 4.8, t('  Open the site  ', C.text) + t('front end', C.dim), doc.vis([64, 96]));
  doc.text(X, questionY + LINE * 5.8, t('  …', C.dim), doc.vis([64, 96]));

  const svg = doc.render('The per-site menu: one-click admin login, database snapshot and restore, recent errors, editor and terminal launchers');
  await writeFile(repo('docs/menu.svg'), svg, 'utf8');
  console.log(`docs/menu.svg written (${Buffer.byteLength(svg)} bytes)`);
}
