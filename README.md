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

**Install — nothing to install**

```bash
npx create-katalyst-laragon@latest doctor   # env check — ends with "Ready to scaffold: YES/NO"
npx create-katalyst-laragon@latest setup    # one-time: enables instant scaffolds (see below)
npx create-katalyst-laragon@latest my-site  # scaffold
```

(Developing the tool itself? `git clone` this repo — anywhere EXCEPT Laragon's `www` folder —
and use `node index.js …` instead of the npx form. Zero dependencies, no `npm install` step.)

**`setup` and instant mode**

`setup` does two one-time things:

1. **Asks your preferences** — which premium plugins (Oxygen / the Breakdance extensions)
   scaffolds should auto-install, and your Oxygen license key (one key covers the
   extensions too). Answers are saved to `~/.katalyst-laragon/config.json` and used by
   every future scaffold; re-run `setup` any time to change them (Enter keeps the current
   answer).
2. **Installs a single wildcard vhost** into Laragon's Apache. This needs one
   **Stop All → Start All** in Laragon (the only restart it will ever ask for) — run
   `setup` again afterwards to confirm it's active. From then on, scaffolding a site
   involves **no Laragon reload at all**: no machine-wide Apache/MySQL blip, no
   multi-minute vhost polling, and none of Laragon's reload-staleness failures. A new site
   is live the instant its folder exists; the only prompt left is one Windows UAC prompt
   per site for its hosts entry.

Without `setup`, everything still works through the classic Laragon-reload flow — it's just
slower and occasionally needs `resume` after Laragon's flaky reload (the failure message
walks you through it).

**First scaffold — what to expect**

- Confirmation prompt, then a UAC prompt for the hosts entry — approve it.
- The first run downloads WP-CLI and WordPress core, so expect a few minutes.

**Updating the tool**

The npx form always runs `@latest` — there is nothing to update. A git checkout updates
with `git pull`.

## Usage

`npx create-katalyst-laragon@latest <command>` from anywhere (or `node index.js <command>`
from a git checkout):

```bash
… <name>              # scaffold a WordPress site at http://<name>.test (or your Laragon suffix)
… setup                # one-time: enable instant scaffolds (no Laragon reloads)
… resume <name>        # finish an interrupted scaffold
… doctor               # check this machine's Laragon/PHP/MySQL/Node state
… list                 # list scaffolded sites
… register-quick-app   # add a Laragon Quick app entry for this tool

# from inside a scaffolded site's directory:
… update               # refresh the site's Katalyst-owned files
… destroy              # permanently remove the site

# flags
… my-site --plugins=akismet,seo-by-rank-math
… my-site --yes        # non-interactive (skips the confirmation prompt)
```

Environment variables (all optional): `KATALYST_LARAGON_ROOT` (Laragon install folder if not
auto-detected), `KATALYST_MYSQL_ROOT_PASSWORD` (when root isn't passwordless/"root"),
`KATALYST_MYSQL_PORT` (when MySQL isn't on 3306), `KATALYST_PREMIUM_PLUGINS_REPO` (see below).

## Premium plugins (Oxygen / Breakdance) — bring your own

Every scaffold auto-installs + activates these three, **if** it can find a licensed zip for
them; missing ones are skipped without breaking anything:

| Plugin slug                        | Accepted zip filenames                     |
| ---------------------------------- | ------------------------------------------ |
| `oxygen`                         | `oxygen.zip` or `oxygen-*.zip`         |
| `breakdance-elements-for-oxygen` | `breakdance-elements-for-oxygen[-*].zip` |
| `breakdance-forms-for-oxygen`    | `breakdance-forms-for-oxygen[-*].zip`    |

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

**License auto-activation:** put your Oxygen license key in
`~/.katalyst-laragon/config.json` once and every scaffold activates it automatically (via
Oxygen's own `wp oxygen license` command; the Elements/Forms extensions are covered by the
same key):

```json
{ "licenses": { "oxygen": "your-32-char-license-key" } }
```

Without a configured key, the scaffold prints a reminder and you activate once in wp-admin
instead. Keep any repo holding licensed zips **private**, and treat `config.json` as
private too — it holds your license key.

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

| Module                               | Owns                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `engine.js`                        | CLI dispatch, the scaffold/resume/update/destroy flows, the cross-process lock                           |
| `laragon.mjs`                      | preflight (who owns :80), reload + poll, vhost reverse-lookup by ROOT, verify-and-repair, hosts snapshot |
| `wp.mjs`                           | the`spawn(php.exe, …, {shell:false})` primitive every `wp` call goes through                        |
| `mysql.mjs`                        | root credential discovery, per-site DB/user provisioning (MySQL + MariaDB)                               |
| `wordpress.mjs`                    | core download/extract (bypasses a broken`wp core download` on Windows), `wp-config.php`, permalinks  |
| `plugins.mjs`                      | plugin install/activate, the Agent Connector pair, premium plugin sync/install                           |
| `junctions.mjs`                    | the sibling-checkout → wp-content workflow, junction-safe directory removal                             |
| `mcp.mjs` / `admin-login.mjs`    | MCP server config per agent, the one-click login mint                                                    |
| `registry.mjs` / `templates.mjs` | the environments registry, the scaffold-time template engine                                             |
| `destroy.mjs` / `quickapp.mjs`   | teardown, the Laragon Quick app registration                                                             |

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
- **Without `setup` (instant mode), `laragon.exe reload` is not fully reliable** once Apache
  has been running a while. Confirmed live, repeatedly, on two machines: it can leave Apache
  serving a stale in-memory config (or crash it outright) — see the file header comments in
  `laragon.mjs` for the full story. When it happens: full Stop All → Start All in Laragon,
  then the `resume <name>` command the failure message prints. **Instant mode removes this
  entire failure class** — run `setup` once.
- **One MCP connection per agent CLI, machine-wide** — see the note above.
- **`--setup-script=`/`--dev-script=` are not implemented.** The original's customization
  hooks didn't make it into this port.
- **Agent CLIs are detected, never installed.** If a selected agent isn't found on PATH, the
  tool skips MCP wiring for it.
