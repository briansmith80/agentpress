// Registers this scaffolder as a Laragon "Quick app" entry, for people who
// prefer starting from the tray menu over the CLI. The CLI stays
// authoritative — this just gives Quick app a way to call into it.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUPS_DIR, LARAGON_ROOT } from './paths.mjs';

const SITES_CONF = join(LARAGON_ROOT, 'usr', 'sites.conf');
const ENTRY_NAME = 'KatalystWP';
// The real clone-based invocation, resolved from this file's own location —
// the previous `npx create-katalyst-laragon %s` pointed at an npm package
// that has never been published, so the tray entry 404'd for everyone.
const INDEX_JS = fileURLToPath(new URL('../index.js', import.meta.url));
// %s quoted: an unquoted multi-word entry ("my site") would otherwise split
// into two argv entries and silently scaffold a site named "my".
const ENTRY_LINE = `${ENTRY_NAME}=node "${INDEX_JS}" "%s" --yes`;

export async function registerQuickApp() {
  let content;
  try {
    content = await readFile(SITES_CONF, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        added: false,
        reason: `Laragon's Quick-app config (${SITES_CONF}) doesn't exist yet — open Laragon once so it creates it, or skip this optional step`,
      };
    }
    throw err;
  }
  if (new RegExp(`^${ENTRY_NAME}=`, 'm').test(content)) {
    return { added: false, reason: `"${ENTRY_NAME}" is already in sites.conf` };
  }
  await mkdir(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(SITES_CONF, join(BACKUPS_DIR, `sites.conf.${stamp}`));
  const updated = `${content.trimEnd()}\n\n# katalyst-laragon\n${ENTRY_LINE}\n`;
  await writeFile(SITES_CONF, updated, 'utf8');
  return { added: true, backup: join(BACKUPS_DIR, `sites.conf.${stamp}`) };
}
