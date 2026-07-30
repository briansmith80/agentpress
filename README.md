# create-katalyst-laragon

A Laragon-native port of [katalystwp](https://github.com/soflyy/katalystwp) — scaffolds a
local WordPress + AI-agent dev site the same way, but on [Laragon](https://laragon.org)
(native Windows: Apache + MySQL + PHP + Node, no Docker) instead of Docker Compose.

## Usage

```bash
node index.js <name>              # scaffold a WordPress site at http://<name>.test
node index.js resume <name>        # finish a scaffold that got through vhost creation but not further
node index.js doctor               # check this machine's Laragon/PHP/MySQL/Node state
node index.js list                 # list scaffolded sites
node index.js update               # refresh a site's Katalyst-owned files (run from its dir)
node index.js destroy              # permanently remove a site (run from its dir)
node index.js register-quick-app   # add a Laragon Quick app entry for this tool

# flags
node index.js my-site --plugins=akismet,seo-by-rank-math
node index.js my-site --yes        # non-interactive
node index.js my-site --verbose    # stream full output instead of the progress line
```

Requires Laragon running (Apache + MySQL) before scaffolding — `doctor` confirms this.

## What gets scaffolded

```
C:\laragon\www\<name>\
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
detected on the machine (Claude Code, Cursor, Codex, OpenCode) — MCP wiring to the site's
WordPress REST API and a stdio Playwright server, plus a one-click already-logged-in
`wp-admin` link via the [Agent Connector](https://github.com/soflyy/agent-connector-for-wp)
plugin (always installed).

## Architecture

Source lives in `src/`, one module per concern:

| Module | Owns |
|---|---|
| `engine.js` | CLI dispatch, the scaffold/resume/update/destroy flows, the cross-process lock |
| `laragon.mjs` | reload + poll, vhost reverse-lookup by ROOT, verify-and-repair, hosts snapshot |
| `wp.mjs` | the `spawn(php.exe, …, {shell:false})` primitive every `wp` call goes through |
| `mysql.mjs` | root credential discovery, per-site DB/user provisioning |
| `wordpress.mjs` | core download/extract (bypasses a broken `wp core download` on Windows), `wp-config.php`, permalinks |
| `plugins.mjs` | plugin install/activate, the Agent Connector pair |
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

## Known limitations

- **`laragon.exe reload` is not fully reliable once Apache has been running a while.**
  Confirmed live, repeatedly: it can leave Apache serving a stale in-memory config (or
  crash it outright) with no code-side fix that doesn't make things worse — see the file
  header comments in `laragon.mjs` for the full story, including a self-relaunch approach
  that was tried and reverted because it introduced a *worse* failure mode (silently serving
  a stale config). When this happens, a full Stop All → Start All in Laragon resolves it;
  the tool detects and reports this rather than guessing.
- **~~Re-running a failed scaffold doesn't resume~~ — fixed: `resume <name>`.** If a run fails
  after the vhost exists but before WordPress finishes installing (the exact state a reload
  staleness failure leaves — see above), `node index.js resume <name>` picks up from there:
  confirms the vhost is reachable, then runs the DB/WordPress/plugins/MCP pipeline. Verified
  live on a real interrupted scaffold. Note it only covers *this* failure point — a run that
  fails earlier (during vhost creation itself) still needs a fresh scaffold, not resume.
- **`--setup-script=`/`--dev-script=` are not implemented.** The original's customization
  hooks (run a script during provisioning, keep a dev server running alongside the stack)
  didn't make it into this port — not in the CLI flags, not in `sandbox.config.json`'s schema.
- **Agent CLIs are detected, never installed.** If a selected agent isn't found on PATH, the
  tool currently just skips MCP wiring for it — it doesn't offer to `npm install -g` it.
