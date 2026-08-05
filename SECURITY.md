# Security

AgentPress (`create-agentpress`) is a **local development tool for Windows**. You run it
deliberately (`npx create-agentpress@latest my-site`) and it scaffolds a WordPress site into
[Laragon](https://laragon.org)'s `www` directory **on your own machine**. It has zero runtime
npm dependencies.

This page exists because a tool that automates local WordPress setup necessarily does several
things that look alarming in isolation. Everything below is verifiable in the source — file
references are given so you don't have to take our word for it.

## What it does NOT do

- **No telemetry, analytics, or crash reporting.** There is no such code. Every network call
  in the package is a `GET`/download; there is no `POST`, `PUT`, or `PATCH` anywhere.
- **No remote targets.** WP-CLI is always invoked as local `php.exe` + the pinned
  `wp-cli-<version>.phar` with `--path=<local folder>` (`src/wp.mjs`). No function in this tool
  accepts a remote host to act on, so it cannot touch a site that isn't a folder on your disk.
- **`wp-cli.phar` is pinned and verified.** Downloaded from a specific WP-CLI release and
  checked against an embedded SHA-512 *before* it is written, then re-verified on every run — a
  mismatching file is replaced, never executed. The filename is version-scoped, so a `wp` you
  installed yourself is never clobbered.
- **No credential collection.** Passwords it generates stay on your machine (the site's own
  `.env`); your Oxygen license key stays in `~/.agentpress/config.json`. Neither is ever
  transmitted anywhere.
- **Outbound destinations, exhaustively:** `wordpress.org` (WordPress core + its checksum),
  `github.com` (WP-CLI releases, the Agent Connector plugin releases, and your own private
  plugin repo *only if you configure one*), `registry.npmjs.org` (version check). There is no
  default premium-plugin repo — nothing is fetched from the author's account.

## Things that look alarming, and why they're necessary

| What | Where | Why |
|---|---|---|
| Executes PHP via `wp eval-file` | `src/admin-login.mjs`, `template/scripts/agentpress.mjs` | Mints a one-time (300s TTL) logged-in `wp-admin` link through the Agent Connector plugin's own public `AdminLoginLink::create` API. The admin user is one **this tool created**, whose password is already in the site's `.env` — the link grants nothing you don't already have. Enforced local-dev hostnames only. |
| Runs PowerShell with `-ExecutionPolicy Bypass` | `src/win.mjs` | OS probes (is Apache up, which PHP is serving) and launching agent CLIs. Bypass is required because `claude`/`codex` install as npm `.ps1` shims that stock Windows' `Restricted` policy refuses to run. Process-scoped; nothing persistent is changed. |
| One UAC-elevated PowerShell | `src/wildcard.mjs` (`ensureHostsEntry`) | Appends `127.0.0.1 <site>.test` to the hosts file — the only privileged operation in the tool. The script it runs is generated locally, the hostname is validated against `/^[a-z0-9.-]+$/i`, and a declined prompt is non-fatal (the scaffold completes and prints the line to add by hand). |
| Writes into Laragon's Apache config | `src/wildcard.mjs` | One wildcard vhost (`setup`, once) so new sites need no Apache reload. Placed last in config order so existing sites always win. |
| Downloads and installs code | `src/wordpress.mjs`, `src/plugins.mjs` | WordPress core and plugins — the tool's entire purpose. |
| Discovers MySQL root credentials | `src/mysql.mjs` | Tries empty then `"root"` (Laragon's defaults) to create a **per-site database and dedicated user**. Root is never written into any scaffolded site. Overridable with `AGENTPRESS_MYSQL_ROOT_PASSWORD`. |
| Writes into agent CLI configs | `src/mcp.mjs` | Registers the site as an MCP server for Claude Code / Cursor / Codex / OpenCode, which is the feature. |

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
- **Codex's MCP wiring puts the application password on a command line, and Claude's fallback
  path can too.** Cursor and OpenCode configs are always written directly as JSON, so the
  credential never reaches an argv for them. Claude is normally written directly as JSON as
  well — but if `~/.claude.json` cannot be read or parsed (most commonly: Claude Code is
  installed but has never been launched, so the file does not exist yet), the code falls back
  to `claude mcp add --env …`, which does put the password on two process command lines. The
  fallback prints a warning when it happens, so you will know.
  Codex's config is TOML and hand-serialising into a user's existing TOML is riskier than the
  exposure, so `codex mcp add` is still used; the credential appears briefly on that process's
  command line, where command-line auditing or EDR can persist it. It grants REST admin on a
  loopback-restricted local site.
- **WordPress core is verified against the SHA-1 that wordpress.org publishes** beside the
  tarball. That detects corruption and in-transit or CDN tampering, but a digest fetched from
  the same origin cannot prove wordpress.org itself is honest. The Agent Connector plugin zips
  are pinned by release tag, which pins a tag rather than bytes.
- **Laragon's Apache binds all interfaces.** That is Laragon's default, not something this tool
  changes, but it means a local dev site is reachable from any network you join. Consider
  restricting the `Apache HTTP Server` Windows Firewall rules to private networks. Note this
  applies to *every* project in your `www` folder, not just AgentPress sites — non-AgentPress
  projects with a root `.env` may be serving it over HTTP.
- **The `.env` exposure check is a warning, not a hard stop.** If your Apache ignores the
  protective `.htaccess`, the scaffold prints a prominent warning and continues rather than
  failing.

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
