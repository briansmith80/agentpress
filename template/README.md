# __PROJECT_NAME__

A local WordPress dev site on [Laragon](https://laragon.org), scaffolded by
[create-katalyst-laragon](https://github.com/soflyy/katalystwp) — a Laragon-native port of
[katalystwp](https://github.com/soflyy/katalystwp).

- **Site** — http://__SITE_HOST__
- **Admin** — http://__SITE_HOST__/wp-admin (credentials in `.env`, gitignored — don't commit it)

## Everyday use

```bash
npm run katalyst   # the interactive menu — open the site, open wp-admin, ...
npm run wp -- <command...>   # WP-CLI, e.g. npm run wp -- plugin list
```

WordPress core lives in `public/` (that's Laragon's document root for this project —
everything else here is Katalyst's own tooling, not part of the site).

## Files

- `.env` — DB credentials, admin credentials, site hostname. Gitignored.
- `sandbox.config.json` — plugins/agents/defines this site was scaffolded with. Re-applied by
  `npm run setup` in a later phase.
- `scripts/katalyst.mjs` — the menu above. Frozen at scaffold time; refreshed only by
  `npx create-katalyst-laragon@latest update`, which never touches your site, database, or
  `.env`.
- `public/` — WordPress core + your content.

## Updating Katalyst's own tooling

```bash
npx create-katalyst-laragon@latest update
```

Refreshes `scripts/`, `wp-cli.yml`, this README, and `package.json`'s own scripts (any script
you added under a different name is preserved). Never touches `.env`, `sandbox.config.json`,
or anything under `public/`.
