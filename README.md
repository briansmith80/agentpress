<img src="docs/wordmark.svg" alt="AgentPress" width="360">

**AI-agent-ready WordPress sites on Windows, in one command.**

[![npm](https://img.shields.io/npm/v/create-agentpress?color=ff2d78&labelColor=15181d)](https://www.npmjs.com/package/create-agentpress)
[![license](https://img.shields.io/badge/license-GPL--2.0--or--later-ff2d78?labelColor=15181d)](LICENSE)
[![platform](<https://img.shields.io/badge/platform-Windows%20+%20Laragon-ff2d78?labelColor=15181d>)](https://laragon.org)

```bash
npx create-agentpress@latest my-site
```

That gives you a WordPress site at `my-site.test` with its own database and
dedicated MySQL user, permalinks working, premium plugins installed and licensed — and
**your AI agent already wired to it**, able to build pages through the
[Agent Connector](https://github.com/soflyy/agent-connector-for-wp) and then open the site
in a real browser to check what it built.

No Docker, no containers, nothing to `npm install`. Native [Laragon](https://laragon.org)
on Windows: Apache + MySQL + PHP + Node. Started as a Laragon-native port of
[katalystwp](https://github.com/soflyy/katalystwp).

## Getting started (fresh machine)

**Prerequisites**

- Windows with [Laragon](https://laragon.org) installed and running **Apache** (not Nginx)
  and **MySQL**. The default `C:\laragon` install location is auto-detected; anywhere else
  works too (set `AGENTPRESS_LARAGON_ROOT` if detection can't find it).
- Node.js 18 or newer.
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`) — only used to auto-sync premium
  plugin zips, everything else works without it.

**Install — nothing to install**

```bash
npx create-agentpress@latest doctor   # env check — ends with "Ready to scaffold: YES/NO"
npx create-agentpress@latest setup    # one-time: enables instant scaffolds (see below)
npx create-agentpress@latest my-site  # scaffold
```

(Developing the tool itself? `git clone` this repo — anywhere EXCEPT Laragon's `www` folder —
and use `node index.js …` instead of the npx form. Zero dependencies, no `npm install` step.)

**`setup` and instant mode**

`setup` does two one-time things:

1. **Gets your premium plugins in place** — shows which ones (Oxygen / the Breakdance
   extensions) already have a licensed zip available on this machine, opens the drop
   folder for you and re-scans after you add zips, and captures your Oxygen license key
   (one key covers the extensions too; saved to `~/.agentpress/config.json`).
   Setup makes plugins **available** — you choose which ones each individual project
   actually gets when you scaffold it.
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

**https, and why a site can show `http://`**

A scaffolded site's **WordPress Address** may read `http://<name>.test`. That is not hardcoded
and not something to fix by hand: `wp-config.php` derives `WP_HOME`/`WP_SITEURL` per request
from the connection the site was reached over, so once an https vhost exists, loading
`https://<name>.test` makes WordPress emit https URLs by itself — no search-replace, no config
edit. What `http://` actually tells you is that SSL was not live at scaffold time, because
`setup` only adds the https half of the wildcard vhost when Laragon's certificate pair exists
(a vhost pointing at a missing certificate file is a hard Apache startup failure, which would
take every site on the machine down with it).

To turn it on: enable SSL in Laragon's menu, re-run `setup`, then — if it says the running
Apache predates the conf — do the one-time **Stop All → Start All**. `doctor` reports TCP :443
and whether the certificate pair is present, so this is visible rather than guesswork.

**First scaffold — what to expect**

- Confirmation prompt, then a UAC prompt for the hosts entry — approve it.
- The first run downloads WP-CLI and WordPress core, so expect a few minutes.

## Updating

Three things move independently, so it is worth knowing which is which:

| What | How | When you need it |
|------|-----|------------------|
| **The tool** | `npx …@latest` already runs the newest version. After `npm i -g create-agentpress`, update with `npm i -g create-agentpress@latest`. | Always, to get new behaviour |
| **A site's own files** (`AGENTS.md`, `/verify`, `scripts/`, `.gitignore`) | `npx create-agentpress@latest update`, from inside that site's folder | Per site, and only for sites you still work in |
| **The machine-wide MCP wiring** | `npx create-agentpress@latest rewire`, from inside any site's folder | Once, when a release changes how agents are wired |

Newly scaffolded sites always get everything current. Existing sites keep the copies they
were built with until you run `update` in them, which is deliberate: it overwrites files you
may have edited, so it asks first.

`rewire`'s main job is pointing your agents at *this* site, since that wiring is
machine-global and the newest scaffold wins. Getting the latest wiring is a side effect, so
running it once in whichever site you want as your MCP target covers both.

## Usage

`npx create-agentpress@latest <command>` from anywhere (or `node index.js <command>`
from a git checkout):

```bash
… <name>              # scaffold a WordPress site at <name>.test (or your Laragon suffix)
… setup                # one-time: enable instant scaffolds (no Laragon reloads)
… resume <name>        # finish an interrupted scaffold
… doctor               # check this machine's Laragon/PHP/MySQL/Node state
… list                 # list scaffolded sites
… register-quick-app   # add a Laragon Quick app entry for this tool

# from inside a scaffolded site's directory:
… update               # refresh the site's AgentPress-owned files
… rewire               # point the AI agents' MCP connection back at THIS site
… destroy              # permanently remove the site

# flags
… my-site --plugins=akismet,seo-by-rank-math   # extra wordpress.org plugins
… my-site --premium=all|none|oxygen,…          # which premium plugins this site gets
… my-site --yes        # non-interactive (skips the confirmation prompt; implies --premium=all)
```

Environment variables (all optional): `AGENTPRESS_LARAGON_ROOT` (Laragon install folder if not
auto-detected), `AGENTPRESS_MYSQL_ROOT_PASSWORD` (when root isn't passwordless/"root"),
`AGENTPRESS_MYSQL_PORT` (when MySQL isn't on 3306), `AGENTPRESS_PREMIUM_PLUGINS_REPO` (see
below). Legacy `KATALYST_*` names from before the rename are still honored.

Output appearance: `AGENTPRESS_NO_BANNER=1` hides the wordmark header, and the standard
`NO_COLOR=1` / `FORCE_COLOR=1` turn colour off / on. Colour and the banner are suppressed
automatically when output isn't a terminal, so piping or redirecting any command gives you
clean plain text.

## Premium plugins (Oxygen / Breakdance) — bring your own

Selection is **per project**: every scaffold shows the plugins that are available on your
machine and asks which ones THIS site should get (a shop needs WooCommerce, a brochure site
doesn't). Scripted runs control it with `--premium=all`, `--premium=none`, or
`--premium=oxygen,breakdance-forms-for-oxygen` (`--yes` alone installs all available;
picking an extension automatically includes Oxygen). The supported set:

| Plugin slug                           | Accepted zip filenames                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `oxygen`                            | `oxygen.zip` or `oxygen-*.zip`                                                  |
| `breakdance-elements-for-oxygen`    | `breakdance-elements-for-oxygen[-*].zip`                                          |
| `breakdance-forms-for-oxygen`       | `breakdance-forms-for-oxygen[-*].zip`                                             |
| `breakdance-woocommerce-for-oxygen` | `breakdance-woocommerce-for-oxygen[-*].zip` (auto-installs WooCommerce alongside) |

After the license activates, the scaffold runs `wp plugin update --all`, so every plugin —
including the Oxygen family, via the vendor's licensed update channel — comes out at its
latest version.

These are commercial plugins with no public download URL, so you supply your own licensed
zips. Two ways, use either or both:

1. **Drop zips in the local cache** (simplest, no GitHub needed):
   `~/.agentpress/premium-plugins/` — filenames must match the table above. Newest by
   file-modified-time wins when several match.
2. **Your own private GitHub repo of releases** (syncs across your machines): create a
   private repo with one release per plugin — the release **tag** must be exactly the plugin
   slug, with the zip attached as an asset. Then point the tool at it, either with the
   `AGENTPRESS_PREMIUM_PLUGINS_REPO=you/your-repo` env var or persistently in
   `~/.agentpress/config.json`:

   ```json
   { "premiumPluginsRepo": "you/your-repo" }
   ```

   Requires `gh` installed and `gh auth login` done. When GitHub is unreachable the tool
   falls back to whatever's already in the local cache.

**License auto-activation:** put your Oxygen license key in
`~/.agentpress/config.json` once and every scaffold activates it automatically (via
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
    agentpress.mjs       the per-site menu (npm run agentpress) — frozen, dependency-free
  .claude\commands\
    verify.md            the /verify procedure — readable by any agent, not just Claude Code
  AGENTS.md              what an AI agent needs to know about this site
  .env                   DB + admin credentials + site hostname (gitignored)
  sandbox.config.json    plugins/agents this site was scaffolded with
  package.json  README.md  wp-cli.yml  .gitignore
```

Each site gets its own MySQL database and dedicated user (never root), its own vhost
(Laragon auto-detects `public/` as the document root), a one-click already-logged-in
`wp-admin` link via the Agent Connector plugin (always installed), and — if any AI agent CLIs
are detected on the machine — MCP wiring for every one of them.

## Two MCP servers, wired automatically (one of them a browser)

Every scaffold configures **both** of these for every detected agent CLI (Claude Code, Cursor,
Codex, OpenCode). There is no separate install step: both run over stdio via `npx`, at versions
this tool pins deliberately.

- **`wordpress`** — the site's own REST API, authenticated with a dedicated WordPress
  application password. Read and write posts and pages, run site queries; with Oxygen installed,
  the builder's own tools show up here too.
- **`playwright`** — browser automation. The agent can load the scaffolded site in a real
  browser, click through it, and screenshot it, so it can check its own work visually instead of
  assuming the markup it wrote looks right.

Confirm both after your first scaffold with `claude mcp list` (or your agent's equivalent —
`codex mcp list`; Cursor and OpenCode list them in their own settings). Both should report
**Connected**. Each one's first launch is slow while `npx` fetches the server package.

### `/verify` — make the site prove it

Every scaffolded site gets an `AGENTS.md` and a `/verify` command. Open the folder in your
agent and run it: it calls the WordPress MCP tools, drives Playwright to load the site, and
checks the Agent Connector abilities.

On a site with Oxygen it also builds a holding page recording exactly what passed and when.
Without Oxygen there is no `html-to-page` to build it with, so `/verify` reports the MCP legs
and says plainly that the page was skipped rather than faking one.

That is worth more than a green tick in a config listing, because **only the agent can test
the agent's path**. `claude mcp list` says an entry exists; `/verify` says the credential still
works, the endpoint answers, and the browser really opened the page. It is also the fastest
way to diagnose the common failure below — if MCP has been repointed at another site, `/verify`
stops immediately and tells you to run `rewire`.

`AGENTS.md` is the other half, and it earns its place between verifications: it carries the
handful of Oxygen behaviours that otherwise fail *silently* (bare CSS tag selectors are
dropped, `@media` queries must match `get-breakpoints` verbatim, and a class is kept only if
your `<style>` defines it *or* it is already registered on the site).

It also carries the one that surprises people most: a `<style>` block passed to
`html-to-page` is **not page-scoped**. Every class in it becomes a global, site-wide Oxygen
selector that outlives the page it came from, so `/verify`'s holding page leaves 11
`agentpress-verify-*` classes behind and later pages can reuse them. Removing them is a
deliberate act in Oxygen's selector list, not something an agent should tidy up: elements
bind to selectors by id, so deleting one strips the class from every page using it, and
re-importing the CSS mints a new id rather than repairing the old reference.

Both files are plain markdown in the site, yours to edit.

**Note:** the MCP wiring is machine-global (one `wordpress` entry per agent CLI), so it always
points at the **most recently scaffolded** site. Scaffolding a second site re-points it;
destroying an old site leaves a newer site's wiring alone. (`playwright` drives whatever URL it
is given, so it never needs re-pointing.)

**To take it back**, run `rewire` from inside the site you want the agents to talk to:

```bash
cd <laragon>\www\my-site
npx create-agentpress@latest rewire
```

It re-points every detected agent CLI at that site, checks the endpoint actually answers (it
prints the number of MCP tools it found), and tells you which site it took the wiring from. It
also mints a fresh application password, which invalidates the site's previous one. Use it after
destroying the site that owned the wiring, or to wire an agent CLI you installed after the site
was created. The site's own `npm run agentpress` menu warns you when the wiring points elsewhere,
and `doctor` shows which site currently owns it.

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
| `mcp.mjs` / `admin-login.mjs`    | MCP server config per agent, endpoint verification, the one-click login mint                             |
| `wildcard.mjs`                     | instant mode — the one wildcard vhost, http + https, and the probes that prove it is live               |
| `doctor.mjs` / `ansi.mjs`        | the environment report, and the colour/glyph/wordmark layer it prints through                            |
| `registry.mjs` / `templates.mjs` | the environments registry, the scaffold-time template engine                                             |
| `destroy.mjs` / `quickapp.mjs`   | teardown, the Laragon Quick app registration                                                             |

`template/` is the payload copied into every scaffolded project: the per-site menu, `AGENTS.md`,
and the `/verify` command. `template/scripts/agentpress.mjs` is **frozen at scaffold time** and
both dependency-free *and* import-free by design — `src/` does not exist beside a scaffolded
site, so it cannot import from it. It therefore carries deliberate duplicated copies of a few
small pieces (the admin-login PHP and its `eval-file` invocation, the colour gate, the wordmark
art), the same reasoning the original project documented for its own three-copy pattern. That
duplication is intentional; `test/parity.test.mjs` and `test/agent-files.test.mjs` are what stop
the copies drifting.

## Uninstalling the tool

Nothing here runs in the background; removing it is deleting things. In order:

1. `node index.js destroy` from inside each scaffolded site you want gone (this cleans the
   DB, vhost, MCP entries, hosts entry, and folder for that site — the hosts entry needs
   a UAC prompt, and declining it just leaves that one line for you).
2. Delete this checkout.
3. Optional leftovers, harmless if kept: `~/.agentpress\` (registry, hosts backups,
   premium plugin zips — note those zips are your licensed property),
   `<laragon>\usr\bin\wp-cli-<version>.phar` + `wp.bat` (shared WP-CLI install — the
   filename is version-scoped, so a bare `wp-cli.phar` there is either a pre-1.2.0
   leftover or your own and is not ours to delete), the `AgentPress` line in
   `<laragon>\usr\sites.conf` if you ran `register-quick-app`, and any leftover hosts
   entries for destroyed sites: `destroy` removes its own `#agentpress` line (sites
   destroyed by versions before 1.9.0 may still have one), and Laragon prunes its own
   `#laragon magic!` lines on reload.

## Security

This is a local dev tool that does a few things that look alarming in isolation (executes PHP
via WP-CLI, runs PowerShell, UAC prompts for the hosts file, installs downloaded plugins).
**[SECURITY.md](SECURITY.md)** explains each one with source references, states what it
deliberately does *not* do (no telemetry, no outbound data, no remote targets), and lists the
limitations we would rather disclose than hide. Worth two minutes before you run any tool that
asks for a UAC prompt.

## Known limitations

- **Apache only.** Nginx mode is detected and refused with a clear message rather than
  supported. Switch Laragon to Apache to use this tool.
- **Without `setup` (instant mode), `laragon.exe reload` is not fully reliable** once Apache
  has been running a while. Confirmed live, repeatedly, on two machines: it can leave Apache
  serving a stale in-memory config (or crash it outright) — see the file header comments in
  `laragon.mjs` for the full story. When it happens: full Stop All → Start All in Laragon,
  then the `resume <name>` command the failure message prints. **Instant mode removes this
  entire failure class** — run `setup` once.
- **One MCP connection per agent CLI, machine-wide** — see the note above. `rewire` moves it
  between sites; there is no way to have two sites wired at once.
- **`--setup-script=`/`--dev-script=` are not implemented.** The original's customization
  hooks didn't make it into this port.
- **Agent CLIs are detected, never installed.** If a selected agent isn't found on PATH, the
  tool skips MCP wiring for it.

## Known issues (upstream)

Bugs in third-party software, not properties of this tool — a vendor fix ends them, so check
your own version before assuming what's below still applies.

- **Oxygen 6.2.0-beta.2: `html-to-page` cannot parse any input — AgentPress patches this for
  you.** The builder wraps your HTML with a leading `<meta charset>` and parses it with
  `LIBXML_HTML_NOIMPLIED`; on libxml 2.10 and newer that combination raises a spurious
  "Memory allocation failed", so the parse returns nothing and *every* input fails, including
  plain text with no tags. Since the WordPress MCP server names `html-to-page` as the
  preferred way to build a page, it is the first thing an agent reaches for.

  Each scaffold applies a one-line fix (an XML encoding declaration instead of the meta tag),
  after the plugin update step so a vendor build cannot undo it. `update` applies it to
  existing sites too. It only ever touches the exact known-broken line, keeps the original as
  `html-to-page.php.agentpress-bak`, and leaves the file alone entirely once Oxygen ships
  their own fix. To skip it, use `--premium=none` or remove Oxygen.

  Worth knowing regardless: you can land on a beta without opting in to one. Every scaffold
  ends with `wp plugin update --all` (see `src/plugins.mjs`), which takes whatever the
  vendor's licensed update feed is serving for the Oxygen family at that moment. Check what
  you actually have from the site's folder (or in wp-admin ▸ Plugins):

  ```bash
  wp plugin list --name=oxygen
  ```
