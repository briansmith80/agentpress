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
- **No remote targets.** WP-CLI is always invoked as local `php.exe` + `wp-cli.phar
  --path=<local folder>` (`src/wp.mjs`). No function in this tool accepts a remote host to act
  on, so it cannot touch a site that isn't a folder on your disk.
- **No credential collection.** Passwords it generates stay on your machine (the site's own
  `.env`); your Oxygen license key stays in `~/.agentpress/config.json`. Neither is ever
  transmitted anywhere.
- **Outbound destinations, exhaustively:** `wordpress.org` (WordPress core),
  `raw.githubusercontent.com` (WP-CLI), `github.com` (the Agent Connector plugin releases, and
  your own private plugin repo if you configure one), `registry.npmjs.org` (version check).

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

- **`wp-cli.phar` is fetched from WP-CLI's official build URL and not hash-pinned.** This is
  the same URL Laragon and most CI pipelines use, but it is trust-on-first-use: a compromise of
  that upstream artifact at the moment of your first scaffold would execute as your user. Being
  addressed; tracked in the repo.
- **The WordPress application password is passed on a PowerShell command line** for
  `claude`/`codex` (their CLIs accept it no other way), so it can appear in process
  command-line audit logs on managed machines. It grants REST admin on a local-only site.
  Cursor and OpenCode are configured by direct JSON write and are not affected.
- **Laragon's Apache binds all interfaces.** That is Laragon's default, not something this tool
  changes, but it means a local dev site is reachable from any network you join. Consider
  Windows Firewall rules for the `Apache HTTP Server` entries if you work on untrusted
  networks.

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
