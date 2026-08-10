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

## Working with an AI agent here

Open this folder in Claude Code (or any agent that reads `AGENTS.md`) and it picks up how
this site is put together, including a few Oxygen behaviours that otherwise fail silently.

Run **`/verify`** to check the whole stack end to end: both MCP servers, the Agent Connector
abilities, and Oxygen if this site has it. With Oxygen it also builds a holding page recording
what passed; without it, that step is skipped and reported rather than faked. Worth doing on
day one, and again any time MCP starts returning 401.

## Files

- `.env` — DB credentials, admin credentials, site hostname. Gitignored.
- `public/wp-config.php` — also holds the DB credentials; also gitignored. If you change the
  ignore rules, keep both of these out of any repo you push.
- `sandbox.config.json` — plugins/agents this site was scaffolded with.
- `scripts/agentpress.mjs` — the menu above. Frozen at scaffold time; refreshed only by the
  `update` command below, which never touches your site, database, or `.env`.
- `AGENTS.md` — what an AI agent needs to know about this site. Yours to edit.
- `.claude/commands/verify.md` — the `/verify` procedure. Any agent can read it, not just
  Claude Code.
- `public/` — WordPress core + your content.

## Updating AgentPress's own tooling

From this directory:

```bash
npx create-agentpress@latest update
```

(Using a git checkout of the tool instead? `git pull` there, then run
`node <path-to-checkout>\index.js update` from here.)

Refreshes `scripts/`, `wp-cli.yml`, `.gitignore`, `AGENTS.md`, `.claude/`, this README, and
`package.json`'s own scripts (any script you added under a different name is preserved, and
so are any dependencies you added). Never touches `.env` or `sandbox.config.json`. If you
hand-edited `.gitignore`, `AGENTS.md` or this README, re-apply those edits after updating.

Two things it writes under `public/`, and nothing else:

- the agent-API loopback guard — a file AgentPress owns outright;
- a one-line fix to Oxygen's `html-to-page`, which otherwise fails on every input on
  PHP builds using libxml 2.10 or newer. This is a patch to a third-party plugin, so it
  is applied only when the exact known-broken line is present, the original is kept
  beside it as `html-to-page.php.agentpress-bak`, and the change is commented in place.
  If Oxygen ships its own fix, AgentPress leaves the file alone.

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
