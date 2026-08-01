# __PROJECT_NAME__

A local WordPress dev site on [Laragon](https://laragon.org), scaffolded by
[create-katalyst-laragon](https://github.com/briansmith80/katalyst-laragon) — a Laragon-native
port of [katalystwp](https://github.com/soflyy/katalystwp).

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
- `public/wp-config.php` — also holds the DB credentials; also gitignored. If you change the
  ignore rules, keep both of these out of any repo you push.
- `sandbox.config.json` — plugins/agents this site was scaffolded with.
- `scripts/katalyst.mjs` — the menu above. Frozen at scaffold time; refreshed only by the
  `update` command below, which never touches your site, database, or `.env`.
- `public/` — WordPress core + your content.

## Updating Katalyst's own tooling

From the katalyst-laragon checkout (wherever you cloned it):

```bash
git pull                    # get the latest tool version
cd <this site's directory>
node <path-to-checkout>\index.js update
```

Refreshes `scripts/`, `wp-cli.yml`, this README, and `package.json`'s own scripts (any script
you added under a different name is preserved, and so are any dependencies you added). Never
touches `.env`, `sandbox.config.json`, or anything under `public/`.
