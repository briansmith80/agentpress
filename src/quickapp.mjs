// Registers this scaffolder as a Laragon "Quick app" entry, for people who
// prefer starting from the tray menu over the CLI. The CLI stays
// authoritative — this just gives Quick app a way to call into it.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUPS_DIR, LARAGON_ROOT } from './paths.mjs';

const SITES_CONF = join(LARAGON_ROOT, 'usr', 'sites.conf');
const ENTRY_NAME = 'KatalystWP';
const ENTRY_LINE = `${ENTRY_NAME}=npx create-katalyst-laragon %s`;

export async function registerQuickApp() {
  const content = await readFile(SITES_CONF, 'utf8');
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
