import { psCapture } from './win.mjs';

export const AGENT_COMMANDS = { claude: 'claude', cursor: 'cursor-agent', codex: 'codex', opencode: 'opencode' };
export const AGENT_LABELS = { claude: 'Claude Code', cursor: 'Cursor CLI', codex: 'Codex CLI', opencode: 'OpenCode' };

async function resolveOnPath(cmd) {
  const { stdout } = await psCapture(`(Get-Command '${cmd}' -ErrorAction SilentlyContinue).Source`);
  return stdout.trim() || null;
}

/** Returns `{ claude: 'C:\...\claude.exe' | null, ... }` — detect-only, never installs anything (that's a separate, explicit opt-in step). */
export async function detectAgents() {
  const result = {};
  for (const [key, cmd] of Object.entries(AGENT_COMMANDS)) {
    result[key] = await resolveOnPath(cmd);
  }
  return result;
}
