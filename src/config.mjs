// ~/.agentpress/config.json — the per-user, per-machine preferences
// store. Schema (all keys optional):
//   premiumPluginsRepo: "owner/repo"     private GitHub repo of licensed zips
//   premiumPlugins:     ["oxygen", ...]  which premium plugins scaffolds
//                                        auto-install; ABSENT = all, [] = none
//   licenses:           { oxygen: key }  license keys applied after install
// Treat the file as private — it holds license keys.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { CONFIG_PATH, AGENTPRESS_HOME } from './paths.mjs';

export async function loadConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveConfig(config) {
  await mkdir(AGENTPRESS_HOME, { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
