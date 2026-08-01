// The scaffolded-project template engine. Ported from the Docker original's
// copyTemplates/RENAME/applyAgentSections — this layer is genuinely
// backend-agnostic and needed no changes beyond the token list.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const RENAME = { gitignore: '.gitignore' };

/** Strips or keeps `# >>> agent:<name> … # <<< agent:<name>` blocks depending on whether that agent was selected — used in package.json/README so unselected agents leave no trace. */
export function applyAgentSections(content, agents) {
  return content.replace(/[ \t]*# >>> agent:(\w+)\n([\s\S]*?)[ \t]*# <<< agent:\1\n/g, (_, name, body) =>
    agents.includes(name) ? body : '',
  );
}

async function walk(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base)));
    else files.push(relative(base, full));
  }
  return files;
}

/**
 * `vars` keys are given WITHOUT the `__..__` wrapper (e.g. `PROJECT_NAME`,
 * not `__PROJECT_NAME__`) — every occurrence of `__KEY__` in a template file
 * is replaced with `vars.KEY`. `skip` matches either the file's relative
 * path or its bare filename, so callers can skip e.g. `package.json`
 * anywhere in the tree with one entry.
 */
export async function copyTemplates(srcDir, destDir, vars, { skip = new Set(), agents = [] } = {}) {
  const relPaths = await walk(srcDir);
  for (const relPath of relPaths) {
    const parts = relPath.split(/[\\/]/);
    const baseName = parts[parts.length - 1];
    if (skip.has(relPath) || skip.has(baseName)) continue;
    parts[parts.length - 1] = RENAME[baseName] || baseName;
    const destPath = join(destDir, ...parts);
    await mkdir(dirname(destPath), { recursive: true });
    let content = await readFile(join(srcDir, relPath), 'utf8');
    content = applyAgentSections(content, agents);
    for (const [key, value] of Object.entries(vars)) {
      content = content.replaceAll(`__${key}__`, value);
    }
    await writeFile(destPath, content, 'utf8');
  }
}

/**
 * package.json needs a smarter merge than a blanket overwrite-or-skip: the
 * template's own scripts should win (that's what `update` is for), but a
 * script the *user* added under a name the template doesn't know about must
 * survive, and the project's own `name` field must survive too. The merge
 * base is the EXISTING file, with template keys layered on top — building
 * from the template instead used to silently delete every user-added field
 * (dependencies, type, engines, ...) on every `update`.
 */
export async function mergePackageJson(templatePath, targetPath, vars) {
  const rendered = (await readFile(templatePath, 'utf8')).replaceAll('__PROJECT_NAME__', vars.PROJECT_NAME);
  const tpl = JSON.parse(rendered);
  let existing = {};
  try {
    existing = JSON.parse(await readFile(targetPath, 'utf8'));
  } catch {
    // no existing file — first write, nothing to merge
  }
  const known = new Set(Object.keys(tpl.scripts || {}));
  const scripts = { ...(tpl.scripts || {}) };
  for (const [key, value] of Object.entries(existing.scripts || {})) {
    if (!known.has(key)) scripts[key] = value;
  }
  const merged = { ...existing, ...tpl, scripts };
  if (existing.name) merged.name = existing.name;
  await writeFile(targetPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}
