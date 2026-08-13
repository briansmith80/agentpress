import { psCapture } from './win.mjs';

export const AGENT_COMMANDS = { claude: 'claude', cursor: 'cursor-agent', codex: 'codex', opencode: 'opencode' };
export const AGENT_LABELS = { claude: 'Claude Code', cursor: 'Cursor CLI', codex: 'Codex CLI', opencode: 'OpenCode' };
// Cursor shipped its CLI as `cursor-agent` (2025) and later renamed the
// command to `agent` (cursor.com/docs/cli/installation, checked 2026-08-12:
// "verify with `agent --version`"). Machines carry either name depending on
// install age, so detection and the menu's launcher both try the unambiguous
// old name first, then the new one. `agent` is far too generic to trust on
// name alone — any other tool could own it — so it only counts when its
// resolved path looks like Cursor's (the installer lands in ~/.local/bin, or
// a path carrying "cursor"). The menu keeps its own copy of BOTH maps
// (frozen file); test/parity.test.mjs pins them together.
export const AGENT_COMMAND_FALLBACKS = { cursor: 'agent' };

async function resolveOnPath(cmd) {
  const { stdout } = await psCapture(`(Get-Command '${cmd}' -ErrorAction SilentlyContinue).Source`);
  return stdout.trim() || null;
}

/** True when a resolved path for the generic `agent` name plausibly belongs to Cursor's CLI rather than some unrelated tool. */
export function looksLikeCursorAgent(resolvedPath) {
  return /cursor|[\\/]\.local[\\/]bin[\\/]/i.test(String(resolvedPath || ''));
}

/** Returns `{ claude: 'C:\...\claude.exe' | null, ... }` — detect-only, never installs anything (that's a separate, explicit opt-in step). */
export async function detectAgents() {
  const result = {};
  for (const [key, cmd] of Object.entries(AGENT_COMMANDS)) {
    result[key] = await resolveOnPath(cmd);
    if (!result[key] && AGENT_COMMAND_FALLBACKS[key]) {
      const fallback = await resolveOnPath(AGENT_COMMAND_FALLBACKS[key]);
      if (fallback && looksLikeCursorAgent(fallback)) result[key] = fallback;
    }
  }
  return result;
}
