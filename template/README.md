# __PROJECT_NAME__

A local WordPress dev site on [Laragon](https://laragon.org), scaffolded by
[create-agentpress](https://github.com/briansmith80/agentpress) — a Laragon-native
port of [katalystwp](https://github.com/soflyy/katalystwp).

- **Site** — __SITE_SCHEME__://__SITE_HOST__
- **Admin** — __SITE_SCHEME__://__SITE_HOST__/wp-admin (credentials in `.env`, gitignored — don't commit it)

## Everyday use

```bash
npm run agentpress   # the interactive menu — open the site, open wp-admin, ...
npm run wp -- <command...>   # WP-CLI, e.g. npm run wp -- plugin list
```

WordPress core lives in `public/` (that's Laragon's document root for this project —
everything else here is AgentPress's own tooling, not part of the site).

## Files

- `.env` — DB credentials, admin credentials, site hostname. Gitignored.
- `public/wp-config.php` — also holds the DB credentials; also gitignored. If you change the
  ignore rules, keep both of these out of any repo you push.
- `sandbox.config.json` — plugins/agents this site was scaffolded with.
- `scripts/agentpress.mjs` — the menu above. Frozen at scaffold time; refreshed only by the
  `update` command below, which never touches your site, database, or `.env`.
- `public/` — WordPress core + your content.

## Updating AgentPress's own tooling

From this directory:

```bash
npx create-agentpress@latest update
```

(Using a git checkout of the tool instead? `git pull` there, then run
`node <path-to-checkout>\index.js update` from here.)

Refreshes `scripts/`, `wp-cli.yml`, `.gitignore`, this README, and `package.json`'s own
scripts (any script you added under a different name is preserved, and so are any
dependencies you added). Never touches `.env` or `sandbox.config.json`. The one thing it
writes under `public/` is the agent-API loopback guard, which is a file AgentPress owns. If
you hand-edited `.gitignore` or this README, re-apply those edits after updating.

## When the AI agents can't see this site

The MCP wiring is machine-wide: there is one `wordpress` server per agent CLI, and it points
at whichever site was scaffolded (or rewired) most recently. So if you scaffold another site,
or destroy the site that owned the wiring, your agents stop being able to reach **this** one.
The menu warns you about that before it launches an agent.

To point them back here, from this directory:

```bash
npx create-agentpress@latest rewire
```

It re-points every agent CLI it finds at this site and confirms the endpoint answers, printing
how many MCP tools it saw. It also mints a fresh application password for this site, which
invalidates the previous one.
