// Terminal colour, status glyphs, and the wordmark banner — hand-rolled ANSI
// with ZERO dependencies, because `package.json` deliberately has no
// `dependencies` key at all (nothing to `npm install` is a stated design
// property of this project, not an accident). chalk/picocolors would each
// break that for ~15 lines of escape codes.
//
// The gate and the pink match `template/scripts/agentpress.mjs`, which
// already shipped this exact pattern per-site — the two must look like one
// product, so the palette lives here and that file carries a documented
// copy (it has to stay importless; see its header).
//
// CRITICAL for callers that align columns: ANSI escapes count as characters
// to `padEnd`/`padStart`/`.length`, so ALWAYS pad first and colour second.
// `row('x'.padEnd(26))` is right; `green('x').padEnd(26)` silently loses 9
// columns of padding per coloured cell.

/**
 * Honours the NO_COLOR convention (https://no-color.org) and skips colour
 * for pipes/files, so `doctor > out.txt` and CI logs stay clean instead of
 * carrying raw escape bytes. FORCE_COLOR opts colour back in for a pager.
 *
 * `Boolean(process.env.X)` is the wrong test for any of these: env values are
 * strings, so `Boolean('0') === true` and `FORCE_COLOR=0` — the established
 * spelling of "disable colour" that chalk/supports-color and plenty of CI
 * images use — would have turned colour ON, and (being the first clause)
 * would have beaten NO_COLOR too. Caught by review with escape bytes landing
 * in a redirected file. envOn/envOff below is why the order is now
 * NO_COLOR first: an explicit "off" must always win over an "on".
 */
const OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);
/** True only for a variable that is set to something other than an explicit "off" value. */
export function envOn(name) {
  const v = process.env[name];
  return v !== undefined && !OFF_VALUES.has(String(v).trim().toLowerCase());
}

export const COLOR = envOn('NO_COLOR')
  ? false
  : envOn('FORCE_COLOR') ||
    (Boolean(process.stdout.isTTY) && !envOn('CI') && process.env.TERM !== 'dumb');

const wrap = (open, close) => (s) => (COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const red = wrap(31, 39);
export const cyan = wrap(36, 39);
export const dim = wrap(2, 22);
export const bold = wrap(1, 22);

// 256-colour fallback (198) for consoles without truecolour — identical
// intent, one shade off. Same values as the per-site menu's PINK.
const PINK_OPEN = (process.env.COLORTERM || '').includes('truecolor') ? '\x1b[38;2;255;45;120m' : '\x1b[38;5;198m';
export const pink = (s) => (COLOR ? `${PINK_OPEN}${s}\x1b[39m` : String(s));

// Status glyphs. ✓/✖/→ were already used ~81 times across engine.js before
// any of this existed — these keep that vocabulary and add ⚠ (a real
// warning) and · (pure information), so "informational" stops having to
// borrow the warning glyph and dilute it.
export const OK = '✓';
export const WARN = '⚠';
export const BAD = '✖';
export const STEP = '→';
export const INFO = '·';

/** Glyph + colour for a status, as one padded-width-1 cell. */
export function mark(status) {
  if (status === 'ok') return green(OK);
  if (status === 'warn') return yellow(WARN);
  if (status === 'bad') return red(BAD);
  if (status === 'step') return cyan(STEP);
  return dim(INFO);
}

/** Colours a value to match its status; 'info' stays default-fg so a healthy run isn't a wall of colour. */
export function tint(status, text) {
  if (status === 'ok') return green(text);
  if (status === 'warn') return yellow(text);
  if (status === 'bad') return red(text);
  if (status === 'step') return cyan(text);
  return String(text);
}

// Block-letter AGENTPRESS. Generated and column-measured rather than typed
// by hand (hand-drawn ASCII art drifts a column and nobody notices until
// it ships); trailing spaces are trimmed so whitespace-stripping editors
// and lint hooks can't silently reshape it — nothing follows on the line,
// so it renders identically.
const BANNER_LINES = [
  ' ██   ██  ████ █  █ ████ ███  ███  ████  ███  ███',
  '█  █ █    █    ██ █  █   █  █ █  █ █    █    █',
  '████ █ ██ ███  █ ██  █   ███  ███  ███   ██   ██',
  '█  █ █  █ █    █  █  █   █    █ █  █       █    █',
  '█  █  ██  ████ █  █  █   █    █  █ ████ ███  ███',
];
const BANNER_WIDTH = 49;

/**
 * The wordmark, pink, with a right-aligned subtitle under it (alignment
 * computed, never a hardcoded indent). Returns '' when the banner is
 * suppressed — AGENTPRESS_NO_BANNER for anyone who finds it noisy, and
 * automatically for non-TTY/NO_COLOR runs, where five rows of U+2588 in a
 * log file are pure noise. Callers can print the result unconditionally.
 */
export function banner(subtitle = '') {
  if (envOn('AGENTPRESS_NO_BANNER') || !COLOR) return '';
  const art = BANNER_LINES.map((l) => pink(l)).join('\n');
  if (!subtitle) return `\n${art}\n`;
  const pad = ' '.repeat(Math.max(0, BANNER_WIDTH - subtitle.length));
  return `\n${art}\n${pad}${dim(subtitle)}\n`;
}
