# Security

AgentPress (`create-agentpress`) is a **local development tool for Windows**. You run it
deliberately (`npx create-agentpress@latest my-site`) and it scaffolds a WordPress site into
[Laragon](https://laragon.org)'s `www` directory **on your own machine**. It has zero runtime
npm dependencies.

This page exists because a tool that automates local WordPress setup necessarily does several
things that look alarming in isolation. Everything below is verifiable in the source — file
references are given so you don't have to take our word for it.

## What it does NOT do

- **No telemetry, analytics, or crash reporting.** Nothing about you, your machine or your
  sites is ever reported to us, and there is no code that could. There *are* POSTs, none of
  them to us: one or two JSON-RPC calls to `127.0.0.1` that prove your new site's MCP endpoint
  actually answers (`verifyMcpEndpoint`, `src/mcp.mjs` — only when an agent CLI was wired), and
  the plugin/theme/core update checks WordPress itself sends to `api.wordpress.org` while the
  scaffold installs and updates plugins. There is no `PUT` or `PATCH` anywhere.
- **No remote targets, with one exception you set up by hand.** WP-CLI is always invoked as
  local `php.exe` + the pinned `wp-cli-<version>.phar` with `--path=<local folder>`
  (`src/wp.mjs`). Scaffold, update, doctor and destroy accept no remote host, so they cannot
  touch a site that isn't a folder on your disk. The exception, since 1.11.0, is `push` and
  `pull` (`src/push.mjs`): they talk to **one** live site, and only after you installed the
  receiver plugin there yourself, created a key in its wp-admin, and ran `push connect` with
  it. Until then no code path has an address to send to. See "Push and pull" below.
- **`wp-cli.phar` is pinned and verified.** Downloaded from a specific WP-CLI release and
  checked against an embedded SHA-512 *before* it is written, then re-verified on every run — a
  mismatching file is replaced, never executed. The filename is version-scoped, so a `wp` you
  installed yourself is never clobbered.
- **No credential collection.** Nothing this tool generates or stores is ever sent to us.
  Generated passwords stay on your machine in the site's own `.env`, and your Oxygen license
  key stays in `~/.agentpress/config.json`. Two qualifications, because "never transmitted"
  was too strong:
  - The only credential this tool puts on a wire is the WordPress application password it has
    just minted, in a `Basic` header to `127.0.0.1` (`src/mcp.mjs`). It never leaves loopback.
  - If you configure an Oxygen license key, activating it necessarily contacts Oxygen. `wp
    oxygen license <key>` is Oxygen's own command, and Oxygen's own code then requests
    `oxygenbuilder.com` with the key and your site URL in the query string
    (`plugin/licensing/class.edd-api.php` in the installed plugin). That is the vendor
    validating your licence, not us collecting it. Leave the key unset and it never happens.
- **Outbound destinations, exhaustively:** `wordpress.org` (WordPress core + its checksum),
  `api.wordpress.org` (WordPress's own plugin lookups and update checks, during plugin
  install/update), `github.com` (WP-CLI releases, the Agent Connector plugin releases, and your
  own private plugin repo *only if you configure one*), `registry.npmjs.org` (the version check
  in a scaffolded site's own script, and the `npx` MCP proxies at each agent session start), and
  `oxygenbuilder.com` (only if you configure a licence key, see above), and the one live site
  you connected with `push connect` (only when you run `push` or `pull`). There is no default
  premium-plugin repo — nothing is fetched from the author's account.

## Things that look alarming, and why they're necessary

| What | Where | Why |
|---|---|---|
| Executes PHP via `wp eval-file` | `src/admin-login.mjs`, `template/scripts/agentpress.mjs` | Mints a one-time (300s TTL) logged-in `wp-admin` link through the Agent Connector plugin's own public `AdminLoginLink::create` API. The admin user is one **this tool created**, whose password is already in the site's `.env` — the link grants nothing you don't already have. Enforced local-dev hostnames only. |
| Runs PowerShell with `-ExecutionPolicy Bypass` | `src/win.mjs` | OS probes (is Apache up, which PHP is serving) and launching agent CLIs. Bypass is required because `claude`/`codex` install as npm `.ps1` shims that stock Windows' `Restricted` policy refuses to run. Process-scoped; nothing persistent is changed. |
| One UAC-elevated PowerShell | `src/wildcard.mjs` (`ensureHostsEntry`) | Appends `127.0.0.1 <site>.test` to the hosts file — the only privileged operation in the tool. The script it runs is generated locally, the hostname is validated against `/^[a-z0-9.-]+$/i` and must end in Laragon's own suffix, `.test` or `.localhost`, and a declined prompt is non-fatal (the scaffold completes and prints the line to add by hand). The script file sits in `%TEMP%` while the prompt is on screen; since 1.11.0 it is locked against writers and its SHA-256 is checked before Windows is asked, so another program cannot swap what you are approving. That removes the cheap route only: a program already running as you can do worse than swap a file. |
| Writes into Laragon's Apache config | `src/wildcard.mjs` | One wildcard vhost (`setup`, once) so new sites need no Apache reload. Placed last in config order so existing sites always win. |
| Downloads and installs code | `src/wordpress.mjs`, `src/plugins.mjs` | WordPress core and plugins — the tool's entire purpose. |
| Discovers MySQL root credentials | `src/mysql.mjs` | Tries empty then `"root"` (Laragon's defaults) to create a **per-site database and dedicated user**. Root is never written into any scaffolded site. Overridable with `AGENTPRESS_MYSQL_ROOT_PASSWORD`. |
| Writes agent MCP configs | `src/mcp.mjs` | Registers the site as an MCP server: into the site's own `.mcp.json` for Claude Code, into home-directory configs for Cursor / Codex / OpenCode. The feature. |
| **Edits a third-party plugin's PHP** | `src/plugins.mjs` (`patchOxygenHtmlToPage`) | The only place this tool modifies code it did not write. Oxygen's `html-to-page` fails on **every** input on libxml ≥ 2.10 (a `<meta charset>` prefix with `LIBXML_HTML_NOIMPLIED` raises a spurious "Memory allocation failed"), and it is the builder's documented primary tool. One line is replaced with an XML encoding declaration. It matches the **exact** known-broken string or refuses aloud, checks the libxml version first, keeps the original as `html-to-page.php.agentpress-bak`, comments the change in the file, never fails a scaffold, and stops applying itself the moment Oxygen ships a fix. Skip it with `--premium=none`. |

## Push and pull

`push` and `pull` are the only commands that reach a server that is not your own machine,
so they get their own section.

- **What is installed on the live site:** one PHP file, `agentpress-push`
  (`src/push/agentpress-push/agentpress-push.php`, readable in full before you upload it). It
  adds three REST routes under `agentpress-push/v1`. With a valid key they can replace the
  site's database, write files under `wp-content` (PHP included, which the server then
  runs), and read both back. **That is the whole site and, through PHP, whatever the site's
  hosting account can reach. Treat the key like the hosting password, not like a WordPress
  login.**
- **The key.** 48 random hex characters, shown once, created and revoked in wp-admin (Tools →
  AgentPress Push, administrators only). The live site stores only a SHA-256 hash, in a PHP
  file under `wp-content/agentpress-push-data/`, not in the database. No key created means
  every route answers 403. Ten wrong keys from one address inside ten minutes and further
  wrong keys from it are refused (429); the correct key is always let in, so someone guessing
  from an address you share cannot lock your own push out. The key page is refused on
  multisite and to anyone who may not install plugins. Revoke the key, or deactivate the
  plugin, whenever you are not about to push: nothing else needs it.
- **The key passes through a command line.** `push connect <line>` puts the connection line
  in your shell history, and for a moment in the process list, where other programs running
  as you can read it. The site menu's Connect item does the same underneath. Create a new
  key (which revokes the old one) if that machine is shared.
- **HTTPS is required.** The command refuses a plain-http address unless the host is this
  machine (`.test`, `.localhost`, `localhost`, `127.x`), at `push connect` and again on
  every run, since the address is read back from `.env`. The plugin refuses plain http the
  same way. `.local` is not treated as local: it is another device on the network. Redirects
  are not followed, so the key is never re-sent to a different host.
- **Where the key sits locally:** `PUSH_REMOTE_URL` and `PUSH_REMOTE_KEY` in the site's
  gitignored `.env`, next to the other generated secrets.
- **The agent plugins never go up.** `agent-connector-for-wp` and
  `universal-abilities-plugin` carry shell-exec, PHP-eval and filesystem-write abilities. A
  push skips their files and removes them from the list of plugins to switch on. Live-verified
  2026-11-11: after a full copy to a site without them, neither folder existed there and the
  MCP route answered 404.
- **Logins do not travel.** Each end keeps its own administrators' passwords. Sign-in sessions
  and application passwords are deleted from a copied database for every user that is not one
  of the receiving site's own administrators.
- **A full copy does not carry passwords up.** Every account a `push --full` brings to the
  live site, other than that site's own administrators, gets a random password there. The
  account stays so its stories keep their author; set a password in wp-admin or use "Lost
  your password?". Before plugin 0.1.4 this was not so: the first real full copy
  (2026-11-11) left the dev site's `admin` on the live server as an administrator with its
  dev password, the one the site menu prints and `.env` holds. **If you ran a full copy
  with an earlier plugin, change those passwords on the live site by hand**; an update does
  not go back and fix them. A `pull` is not covered: the live site's accounts arrive on the
  dev machine with their real password hashes, as in any database copy.
- **The plugin never turns arriving data into objects.** Both places it reads a serialized
  value from a copy (address rewriting, the active-plugin list) run `unserialize` with
  `allowed_classes => false`. WordPress itself will unserialize a copied option later, when
  it reads it, as it does with any imported database.
- **A pull trusts the live site, within limits.** A pull runs on your machine with what the
  live site sends, and the live site is the end more likely to have been tampered with. Since
  plugin 0.1.5 a pull: unpacks files under `uploads` only and refuses anything else in the
  pack (before this, a pack carrying `mu-plugins/x.php` would have been unpacked and run);
  leaves out upload files that could run as code (`.php`, `.phtml`, `.phar`, `.htaccess`,
  `.user.ini`) and names them; keeps your site's own `upload_path`, so a copied setting
  cannot point the uploads folder somewhere else on your disk; keeps your own theme setting;
  and runs only a plain `CREATE TABLE` from the export as SQL. **What it cannot check is the
  content itself.** Oxygen stores design data in the database, and that data can hold PHP
  code blocks which Oxygen runs when the page is built. Posts can hold scripts. A pull
  brings those down as they are. **Do not pull from a live site you believe has been broken
  into.** These guards were found by a review and proven between two local sites; none of
  them has met a real attack.
- **Temporary files on the live site.** During a job the database export and file packs sit
  in a folder with a 32-character random name under `wp-content/agentpress-push-data/`, and
  are deleted when the job ends, also when you stop it with Ctrl+C. A job that is killed
  outright (the window closed, the machine asleep) leaves them; the plugin removes any job
  folder not written to for six hours the next time it is asked anything, so until then a
  database export, with every user's email and password hash, sits there. The folder
  carries a `Require all denied` `.htaccess`. **A
  server that ignores `.htaccess` (nginx) does not enforce that**, and there the unguessable
  folder name is the only protection for the minutes a job runs. Saved design backups (the
  last ten, design data only, no users or passwords) stay in that folder between jobs, under
  random names since 0.1.5 (earlier ones were named by date and time alone).
- **A page cache must not keep what the plugin answers.** The key is a request header, not a
  WordPress login, so to a page cache every request looks like an anonymous visitor. Found on
  the first real server (2026-11-11, LiteSpeed with the LiteSpeed Cache plugin, plugin 0.1.2):
  the server stored a file-list download and then gave that stored copy to a request with **no
  key at all**, because a cache hit never reaches the key check. The address held a
  32-character random job id, so it was not guessable, and only a list of file names and sizes
  was fetched that way; no database export was. From 0.1.3 the plugin forbids caching of
  every answer (also the refusals) and the sender never asks for the same address twice.
  If you ran a pull or push with 0.1.2 against a LiteSpeed server, purge its cache once.
- **Lightly proven:** every command has run at least once against one real server (cPanel,
  LiteSpeed, PHP 8.4): connect, status, the preview, the first full copy and its undo, a
  design push and its undo, and a pull. No other host, web server or PHP version has seen it.
  That was plugin 0.1.4. **Plugin 0.1.5 (the review fixes above, plus: a retried step is
  answered from its kept reply instead of run again, and the password reset is one statement)
  has run only between two local sites.**
- **Known limits, not fixed.** The database export pages through each table by row offset,
  which slows down on very large tables and can skip or repeat a row if the live site is
  written to during a pull. Everything travels as one pack with no free-disk check first.
  The kept database (`apold_` tables) stays until the next full copy; there is no command to
  drop it. A job that fails halfway is started again from the top, not resumed. A second
  full copy to a site whose plugins use named foreign keys (WooCommerce) is untested and may
  collide on those names.

## Where secrets live
- `<site>/.env` — DB and WordPress admin passwords this tool generated. It sits **outside** the
  site's docroot (`public/`), and the tool writes a `Require all denied` `.htaccess` in the
  project root and then **actively verifies over HTTP that `.env` is not served**, warning
  loudly if your Apache configuration ignores it (`protectProjectSecrets` in `src/engine.js`).
- `~/.agentpress/config.json` — your Oxygen license key. Treat as private; never committed.
- Scaffolded sites' `.gitignore` excludes `.env`, `public/wp-config.php`, and the commercial
  plugin trees.

## Known limitations we'd rather state than hide

- **Scaffolded sites carry the Agent Connector abilities pack** — shell-exec, PHP-eval and
  filesystem write, available to an authenticated administrator. That capability *is* the
  product for an AI-agent dev site. It is contained rather than removed: requests from a
  non-loopback address are rejected with a 403 on **both** REST namespaces that reach those
  abilities — `mcp/…` (the Agent Connector's MCP adapter) and `wp-abilities/…` (WordPress
  core's own Abilities API, which every ability opts into via `show_in_rest`). Covering only
  `mcp/` is the trap here: `POST /wp-json/wp-abilities/v1/abilities/…/shell-exec/run` reaches
  shell-exec without touching an MCP route at all.

  Two layers enforce it, and they are not equal:
  - `public/wp-content/mu-plugins/agentpress-mcp-loopback-guard.php` is the control that
    actually holds. It filters `rest_pre_dispatch` and tests **WordPress's own resolved
    route**, so it cannot be walked around by re-spelling the URL. Deleting this file
    re-exposes the abilities pack to every network the machine joins.
  - the marked block in `public/.htaccess` blocks the known URL shapes at Apache, before PHP
    loads. Defence in depth *only*, and we can say precisely why it is not sufficient: Apache
    decodes the request **path** before those conditions run, but never the **query string**,
    so `?rest_route=%2Fmcp%2Fx` matches nothing there while PHP still hands WordPress a
    decoded `/mcp/x` and the route resolves normally (verified live). Removing this block
    alone does not re-expose anything — the mu-plugin still rejects every shape — but it
    removes the layer that stops those requests before PHP runs.

  **History, stated plainly:** from v1.1.0 up to and including v1.3.0 the rewrite was the only
  layer, it matched `REQUEST_URI ^/wp-json/mcp/` only, and it was therefore bypassable via
  `?rest_route=/mcp/…` and `/index.php/wp-json/mcp/…`; the `wp-abilities/…` namespace was not
  covered at all. Both gaps were found by audit and fixed in v1.4.0.

  Sites scaffolded before v1.4.0 have neither the mu-plugin nor the widened rewrite — run
  `npx create-agentpress@latest update` from inside that site's folder to add both.

  **A tunnel makes the internet look local.** Laragon's Share, ngrok, cloudflared and a
  forwarded port all run on your machine, so every request they carry arrives from
  `127.0.0.1`, and until 1.11.0 the guard let all of it reach the agent routes (credentials
  were still needed). From 1.11.0 the mu-plugin also refuses a request to those routes that
  carries a forwarding header (`X-Forwarded-For`, `X-Forwarded-Host`, `Forwarded`,
  `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP`), which those tools add. Verified on
  a local site: the same request answers 401 without the header and 403 with it. A tunnel
  that adds none of them is not caught, and the `.htaccess` layer does not look at headers
  at all. **Do not share a site that has the agent plugins switched on.** Existing sites
  get this with `update`.
- **Up to and including v1.4.0, application passwords were never actually revoked.** The code
  passed the password's NAME to `wp user application-password delete`, which takes UUIDs, so it
  matched nothing and silently did nothing. Two consequences: every re-mint (a re-scaffold, a
  `resume`) left the previous credential live rather than replacing it, and `destroy` revoked
  nothing while telling you it had. Each of those is an admin-equivalent REST credential that
  reaches the abilities pack. v1.5.0 resolves the UUIDs and revokes all of ours, and reports
  when it cannot. **On a site you created before v1.5.0**, run `rewire` from its folder (or
  `destroy` it) to clear the backlog, or delete the extras in wp-admin ▸ Users ▸ Profile ▸
  Application Passwords. Note `update` will *not* do it — it never touches credentials.
- **Where the application password lands, per agent.** Cursor and OpenCode configs are written
  directly as JSON in your home directory, so the credential never reaches an argv for them.
  Claude Code (since 1.10.0) is wired **per site**: the credential is written directly as JSON
  into that site's own `.mcp.json`, never onto a command line and never into a machine-global
  file. That file lives inside the site folder, so the tool gitignores it (the template ships
  the rule, and every wiring re-ensures it) — but if you replace the site's `.gitignore` or
  force-add the file, you are committing an admin-equivalent REST credential, exactly as you
  would be by committing the `.env` that already lives beside it. Sites wired before 1.10.0
  keep their old machine-global `~/.claude.json` entry until you run `rewire` in them; the old
  argv-exposing `claude mcp add` fallback is gone entirely.
  Codex's config is TOML and hand-serialising into a user's existing TOML is riskier than the
  exposure, so `codex mcp add` is still used; the credential appears briefly on that process's
  command line, where command-line auditing or EDR can persist it. It grants REST admin on a
  loopback-restricted local site.
- **WordPress core is verified against the SHA-1 that wordpress.org publishes** beside the
  tarball, and a mismatch aborts before anything is written to disk. Two limits worth stating.
  A digest fetched from the same origin cannot prove wordpress.org itself is honest. And the
  check **fails open**: if the `.sha1` sidecar cannot be fetched, or comes back malformed, the
  tool prints one line saying so and installs core unverified rather than refusing. That is a
  deliberate trade for a local dev tool that has to work on a flaky connection, but it does mean
  the absence of that line is the only signal the check actually ran. The Agent Connector plugin
  zips are pinned by release tag, which pins a tag rather than bytes.
- **Laragon's Apache binds all interfaces.** That is Laragon's default, not something this tool
  changes, but it means a local dev site is reachable from any network you join. Consider
  restricting the `Apache HTTP Server` Windows Firewall rules to private networks. Note this
  applies to *every* project in your `www` folder, not just AgentPress sites — non-AgentPress
  projects with a root `.env` may be serving it over HTTP.
- **The `.env` exposure check is a warning, not a hard stop.** If your Apache ignores the
  protective `.htaccess`, the scaffold prints a prominent warning and continues rather than
  failing. **And on a machine that already denies `.env` by name at server level, the check
  cannot fail at all**: it asks for `/<site>/.env` and a 403 looks the same whether the
  project's own `.htaccess` is honoured or not. It never asks for `.mcp.json`, which holds
  an administrator-equivalent password. Known, not yet fixed.
- **`destroy` checks that `.env` describes the folder it is run in** (since 1.11.0).
  Everything it removes outside the folder (the database and its user, the application
  password, the hosts line) is named by `.env`, and a copied site folder carries the
  original's `.env`. Before 1.11.0, `destroy` run inside such a copy dropped the
  ORIGINAL site's database. It now refuses, also under `--yes`, unless the database
  server is this machine and `SITE_HOST` is this folder's name (or the hostname the registry
  holds for this exact folder). The preamble names the database and address it will remove.
- **Found by the same review (2026-11-11) and not fixed yet:**
  - `public/wp-content/plugins/oxygen/…/html-to-page.php.agentpress-bak` (the backup the
    Oxygen patch keeps) is served as plain text, and so is `wp-content/debug.log` once you
    switch WP_DEBUG_LOG on from the site menu.
  - The site menu starts `npx`, `powershell` and `wp` by bare name from the site
    folder, so a file of that name planted there would run instead. Anything able to write
    there can already edit the menu script, so this buys an attacker little.
  - The scaffold summary prints the admin password and the one-click login link even when
    output is not a terminal, so an agent-driven scaffold puts them in its transcript.
  - The abilities pack (the plugin that carries shell-exec) is installed from a moving
    tag, not a fixed version, and `plugin update --all` runs right after.
  - `resume` takes `SITE_HOST` from `.env` without the checks `rewire` applies. The
    hosts write now refuses a non-local name, which was the part that mattered.

## Automated scanner reports

`src/admin-login.mjs` has been flagged by an AI-based supply-chain scanner as probable
privilege-escalation tooling. We believe this is a false positive on intent and have documented
the model in that file's header; the local-dev-hostname restriction is now enforced in code so
the claim is mechanically checkable rather than asserted. If you are evaluating this package and
that alert is your concern, the three facts that resolve it are: the path is a local folder, the
admin is self-created, and its password is already in the site's `.env`.

## Reporting a vulnerability

Open a GitHub issue at https://github.com/briansmith80/agentpress/issues. For something you
believe should not be public first, use GitHub's private vulnerability reporting on that repo.
This is a hobby project maintained by one person — expect best-effort, not an SLA.
