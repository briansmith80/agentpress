// Generates the README's animated demos:
//
//   node tools/hero.mjs
//     -> docs/hero.svg   (a scaffold run: command, wordmark, steps, panel)
//     -> docs/menu.svg   (the site menu: main menu, Live site, a push preview)
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
// Three screens, because since 1.11.0 the menu IS one screen at a time: it
// repaints whole at each step instead of leaving a log of every question
// asked. So the scenes replace each other (snap, no crossfade - a repaint is
// instant, and a crossfade would show two menus at once), and the third one
// drops the header, because what a command prints goes to the normal screen
// under one heading line. The demo before this showed the old log look, with
// the answered question still sitting above the next menu.
{
  const X = 36;
  const LINE = 23;
  const doc = makeDoc({ width: 860, height: 440, seconds: 24, label: 'm' });
  const LIVE = 'my-site.example';

  // Like the hero: open with the command that gets you here, then the menu.
  doc.text(X, 64, t('PS C:\\laragon\\www\\my-site> ', C.dim) + t('npm run agentpress'), doc.vis([1, 6]));

  // The credential header the real menu prints (URLs are links, i.e. pink).
  // It is on screen for both menus and gone for the result.
  let y = 64;
  const header = [
    ['WordPress', 'https://my-site.test', C.pink],
    ['Admin', 'https://my-site.test/wp-admin', C.pink],
    ['Username', 'admin', C.text],
    ['Password', 'wp-....-....', C.text],
  ];
  for (const [name, value, fill] of header) {
    doc.raw(`<text x="${X}" y="${y}" ${FONT}>${t(name)}</text><text x="${X + 110}" y="${y}" ${FONT}>${t(value, fill)}</text>`, doc.vis([8, 66], { snap: true }));
    y += LINE;
  }
  const questionY = y + LINE * 0.5;

  /**
   * One menu screen: a question, its rows, and a cursor that sits on each of
   * `walk`'s rows in turn. `walk` is [rowIndex, from%, to%]; every other
   * moment a row is drawn plain.
   */
  const screen = (question, items, [from, to], walk) => {
    doc.text(X, questionY, t('? ', C.pink) + t(question), doc.vis([from, to], { snap: true }));
    items.forEach(([labelText, hint, hintFill = C.dim], i) => {
      const rowY = questionY + LINE * 1.2 + i * LINE;
      const hintPart = hint ? t('  ' + hint, hintFill) : '';
      const on = walk.filter(([row]) => row === i).map(([, a, b]) => [a, b]);
      if (!on.length) {
        doc.text(X, rowY, t('  ') + t(labelText) + hintPart, doc.vis([from, to], { snap: true }));
        return;
      }
      // Plain in the gaps around the cursor's visit; the pink overlay covers the visit.
      const plain = [];
      let at = from;
      for (const [a, b] of on) {
        if (a > at) plain.push([at, a]);
        at = b;
      }
      if (at < to) plain.push([at, to]);
      if (plain.length) doc.text(X, rowY, t('  ') + t(labelText) + hintPart, doc.vis(plain, { snap: true }));
      doc.text(X, rowY, t('> ', C.pink) + t(labelText, C.pink) + hintPart, doc.vis(on, { snap: true }));
    });
  };

  // Screen 1: the real option list, hints included. The cursor walks down to Live site.
  screen(
    'What would you like to do?',
    [
      ['Open WP Admin', 'one-click login'],
      ['Open the site', 'front end'],
      ['Open Claude Code', 'MCP points here'],
      ['Snapshot the database', 'rollback point before agent sessions'],
      ['Restore the latest snapshot', 'db-2026-11-11T09-12-44Z.sql'],
      ['Live site', `push and pull · ${LIVE}`],
      ['Show recent errors', 'debug on — nothing logged yet'],
      ['Open in VS Code', 'this site folder'],
      ['Open a terminal here', ''],
      ['Exit', ''],
    ],
    [9, 36],
    [
      [0, 9, 14],
      [1, 14, 17],
      [2, 17, 20],
      [3, 20, 23],
      [4, 23, 26],
      [5, 26, 36],
    ],
  );

  // Screen 2: the same place on screen, repainted. Nothing of screen 1 is left behind.
  screen(
    `Live site ${LIVE}`,
    [
      ['Check status', 'compare this site with live'],
      ['Preview a design push', 'shows the plan, sends nothing'],
      ['Push design to live', 'asks first; stories on live are kept'],
      ['Pull content from live', 'asks first; this local site becomes a copy of live'],
      ['Undo…', 'the last push, pull or full copy'],
      ['First launch: full copy to live', 'replaces everything on live', '#d9a441'],
      ['Set up or reconnect…', 'plugin zip, new connection key'],
      ['Back', ''],
    ],
    [38, 66],
    [
      [0, 38, 46],
      [1, 46, 66],
    ],
  );

  // Screen 3: what the command printed, on the normal screen under one
  // heading line. These are the tool's own strings for a design-push preview.
  y = 64;
  const out = (at, content, gap = 1) => {
    doc.text(X, y, content, doc.vis([at, 97]));
    y += LINE * gap;
  };
  out(68, t('? ', C.pink) + t(`Live site ${LIVE} `) + t('› ', C.dim) + t('Preview a design push'), 1.6);
  out(70, `<tspan font-weight="bold">${t('Design push')}</tspan>` + t(`  https://my-site.test  `) + t('→', C.cyan) + t(`  https://${LIVE}`));
  out(72, t('  … reading the design here', C.dim));
  out(74, t('  … comparing files (mu-plugins, themes)', C.dim));
  out(76, t('  … comparing files (uploads)', C.dim), 1.6);
  out(79, t(`  On ${LIVE} this will:`));
  out(81, t('    change  footer    Site Footer'));
  out(83, t('    send    media     2 files live does not have (412 KB)'));
  out(85, t("  Stories, users, comments and the editor's own uploads are not touched.", C.dim), 1.6);
  out(88, t('· ', C.dim) + t('Dry run: nothing was changed.'), 1.6);
  out(91, t('  Press any key to go back to the menu…', C.dim));

  const svg = doc.render('The per-site menu, one screen at a time: pick Live site, preview a design push, read the plan it would send');
  await writeFile(repo('docs/menu.svg'), svg, 'utf8');
  console.log(`docs/menu.svg written (${Buffer.byteLength(svg)} bytes)`);
}
