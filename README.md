# create-katalyst-laragon

A Laragon-native port of [katalystwp](https://github.com/soflyy/katalystwp) — scaffolds a
local WordPress + AI-agent dev site the same way, but on [Laragon](https://laragon.org)
(native Windows: Apache + MySQL + PHP + Node, no Docker) instead of Docker Compose.

One command gives you: a site at `http://<name>.test` with its own database and dedicated
MySQL user, permalinks working, the [Agent Connector](https://github.com/soflyy/agent-connector-for-wp)
MCP gateway installed, MCP wiring for any AI agent CLI on your machine (Claude Code, Cursor,
Codex, OpenCode), and a one-click already-logged-in wp-admin link.

## Getting started (fresh machine)

**Prerequisites**

- Windows with [Laragon](https://laragon.org) installed and running **Apache** (not Nginx)
  and **MySQL**. The default `C:\laragon` install location is auto-detected; anywhere else
  works too (set `KATALYST_LARAGON_ROOT` if detection can't find it).
- Node.js 18 or newer.
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`) — only used to auto-sync premium
  plugin zips, everything else works without it.

**Install**

```bash
# Clone anywhere EXCEPT into Laragon's www folder (C:\laragon\www by default) —
# Laragon would give the tool folder its own vhost on the next reload.
git clone https://github.com/briansmith80/katalyst-laragon.git
cd katalyst-laragon
node index.js doctor    # always run this first — ends with "Ready to scaffold: YES/NO"
```

There is no `npm install` step — the tool has zero dependencies.

**First scaffold — what to expect**

```bash
node index.js my-site
```

- It asks for confirmation, then warns you: creating a site triggers a Laragon reload that
  briefly restarts Apache/MySQL for **every** site on the machine.
- A Windows permission prompt may appear for the hosts-file update — approve it.
- The first run downloads WP-CLI and WordPress core, so expect a few minutes.
- **If it fails partway** (Laragon's reload is genuinely flaky once Apache has been running
  a while): do a full **Stop All → Start All** in Laragon, then run
  `node index.js resume my-site`. The failure message tells you this too.

**Updating the tool**

```bash
git pull    # in this checkout
```

Then, per site you want refreshed: `cd` into the site directory and run
`node <path-to-this-checkout>\index.js update`.

## Usage

From the tool's checkout:

```bash
node index.js <name>              # scaffold a WordPress site at http://<name>.test (or your Laragon suffix)
node index.js resume <name>        # finish an interrupted scaffold
node index.js doctor               # check this machine's Laragon/PHP/MySQL/Node state
node index.js list                 # list scaffolded sites
node index.js register-quick-app   # add a Laragon Quick app entry for this tool

# flags
node index.js my-site --plugins=akismet,seo-by-rank-math
node index.js my-site --yes        # non-interactive (skips the confirmation prompt)
```

From inside a scaffolded site's directory (`node index.js` only resolves in the checkout, so
use the full path):

```bash
node <path-to-checkout>\index.js update    # refresh the site's Katalyst-owned files
node <path-to-checkout>\index.js destroy   # permanently remove the site
```

Environment variables (all optional): `KATALYST_LARAGON_ROOT` (Laragon install folder if not
auto-detected), `KATALYST_MYSQL_ROOT_PASSWORD` (when root isn't passwordless/"root"),
`KATALYST_MYSQL_PORT` (when MySQL isn't on 3306), `KATALYST_PREMIUM_PLUGINS_REPO` (see below).

## Premium plugins (Oxygen / Breakdance) — bring your own

Every scaffold auto-installs + activates these three, **if** it can find a licensed zip for
them; missing ones are skipped without breaking anything:

| Plugin slug | Accepted zip filenames |
|---|---|
| `oxygen` | `oxygen.zip` or `oxygen-*.zip` |
| `breakdance-elements-for-oxygen` | `breakdance-elements-for-oxygen[-*].zip` |
| `breakdance-forms-for-oxygen` | `breakdance-forms-for-oxygen[-*].zip` |

These are commercial plugins with no public download URL, so you supply your own licensed
zips. Two ways, use either or both:

1. **Drop zips in the local cache** (simplest, no GitHub needed):
   `~/.katalyst-laragon/premium-plugins/` — filenames must match the table above. Newest by
   file-modified-time wins when several match.
2. **Your own private GitHub repo of releases** (syncs across your machines): create a
   private repo with one release per plugin — the release **tag** must be exactly the plugin
   slug, with the zip attached as an asset. Then point the tool at it, either with the
   `KATALYST_PREMIUM_PLUGINS_REPO=you/your-repo` env var or persistently in
   `~/.katalyst-laragon/config.json`:

   ```json
   { "premiumPluginsRepo": "you/your-repo" }
   ```

   Requires `gh` installed and `gh auth login` done. When GitHub is unreachable the tool
   falls back to whatever's already in the local cache.

Installing a plugin doesn't activate its license — if it needs a key, that's still a manual
one-time step in wp-admin after the scaffold finishes. And keep any repo holding licensed
zips **private**.

## What gets scaffolded

```
<laragon>\www\<name>\
  public\               WordPress core (Apache's document root)
    .htaccess           permalinks + the Authorization-header fix Application Passwords need
    .user.ini           per-site PHP limits (mod_fcgid ignores .htaccess php_value)
  scripts\
    katalyst.mjs         the per-site menu (npm run katalyst) — frozen, dependency-free
  .env                   DB + admin credentials + site hostname (gitignored)
  sandbox.config.json    plugins/agents this site was scaffolded with
  package.json  README.md  wp-cli.yml  .gitignore
```

Each site gets its own MySQL database and dedicated user (never root), its own vhost
(Laragon auto-detects `public/` as the document root), and — if any AI agent CLIs are
detected on the machine — MCP wiring to the site's WordPress REST API and a stdio Playwright
server, plus a one-click already-logged-in `wp-admin` link via the Agent Connector plugin
(always installed).

**Note:** the MCP wiring is machine-global (one `wordpress` entry per agent CLI), so it always
points at the **most recently scaffolded** site. Scaffolding a second site re-points it;
destroying an old site leaves a newer site's wiring alone.

## Architecture

Source lives in `src/`, one module per concern:

| Module | Owns |
|---|---|
| `engine.js` | CLI dispatch, the scaffold/resume/update/destroy flows, the cross-process lock |
| `laragon.mjs` | preflight (who owns :80), reload + poll, vhost reverse-lookup by ROOT, verify-and-repair, hosts snapshot |
| `wp.mjs` | the `spawn(php.exe, …, {shell:false})` primitive every `wp` call goes through |
| `mysql.mjs` | root credential discovery, per-site DB/user provisioning (MySQL + MariaDB) |
| `wordpress.mjs` | core download/extract (bypasses a broken `wp core download` on Windows), `wp-config.php`, permalinks |
| `plugins.mjs` | plugin install/activate, the Agent Connector pair, premium plugin sync/install |
| `junctions.mjs` | the sibling-checkout → wp-content workflow, junction-safe directory removal |
| `mcp.mjs` / `admin-login.mjs` | MCP server config per agent, the one-click login mint |
| `registry.mjs` / `templates.mjs` | the environments registry, the scaffold-time template engine |
| `destroy.mjs` / `quickapp.mjs` | teardown, the Laragon Quick app registration |

`template/` is the payload copied into every scaffolded project — most notably
`template/scripts/katalyst.mjs`, which is **frozen at scaffold time** and dependency-free by
design (no npm installs needed to run it). It necessarily duplicates a few small pieces from
`src/` (the admin-login PHP + its `eval-file` invocation, the same reasoning the original
project documented for its own three-copy pattern) — that duplication is intentional, not
an oversight.

## Uninstalling the tool

Nothing here runs in the background; removing it is deleting things. In order:

1. `node index.js destroy` from inside each scaffolded site you want gone (this cleans the
   DB, vhost, MCP entries, and folder for that site).
2. Delete this checkout.
3. Optional leftovers, harmless if kept: `~/.katalyst-laragon\` (registry, hosts backups,
   premium plugin zips — note those zips are your licensed property),
   `<laragon>\usr\bin\wp-cli.phar` + `wp.bat` (shared WP-CLI install), the `KatalystWP` line
   in `<laragon>\usr\sites.conf` if you ran `register-quick-app`, and any `#laragon magic!`
   hosts entries for destroyed sites (Laragon prunes these on reload).

## Known limitations

- **Apache only.** Nginx mode is detected and refused with a clear message rather than
  supported. Switch Laragon to Apache to use this tool.
- **`laragon.exe reload` is not fully reliable once Apache has been running a while.**
  Confirmed live, repeatedly, on two machines: it can leave Apache serving a stale in-memory
  config (or crash it outright) with no code-side fix that doesn't make things worse — see
  the file header comments in `laragon.mjs` for the full story. When it happens: full
  Stop All → Start All in Laragon, then `node index.js resume <name>`. The tool detects and
  reports this rather than guessing.
- **One MCP connection per agent CLI, machine-wide** — see the note above.
- **`--setup-script=`/`--dev-script=` are not implemented.** The original's customization
  hooks didn't make it into this port.
- **Agent CLIs are detected, never installed.** If a selected agent isn't found on PATH, the
  tool skips MCP wiring for it.
