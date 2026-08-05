# Releasing

The long-form reasoning lives in [CLAUDE.md](CLAUDE.md). This is the checklist.

Every step is here because skipping it has cost this project at least once.

## 1. Verify locally

```bash
npm test                    # pure + behavioural suites, no Laragon needed
npm run check               # syntax on the entry points
node test/assert-tarball.mjs
node index.js doctor        # must exit 0
AGENTPRESS_LARAGON_ROOT=C:/nope node index.js doctor   # must exit 1
```

CI runs all of the above on every push. It cannot run the next step.

## 2. Run a real scaffold — if anything on the scaffold path changed

There is no substitute. Code review does not catch composed-output bugs, and
the automated suite deliberately never touches Laragon.

**Back up the `mcpServers` block of `~/.claude.json` first.** MCP wiring is
machine-global, so scaffolding repoints your live `wordpress` connection at the
test site and destroying that site then removes the entry entirely.

```bash
node index.js aptestNNN --yes --premium=none
curl -sk -o /dev/null -w "%{http_code}" https://aptestNNN.test/hello-world/   # 200
curl -sk -o /dev/null -w "%{http_code}" https://aptestNNN.test/.env           # 404 or 403
cd C:/laragon/www/aptestNNN && node <repo>/index.js destroy --yes
```

On `.env`, what matters is **not 200**. 404 is the usual answer (the file lives
above the docroot, so it simply is not there); some Apache configurations deny
dotfiles outright and answer 403, which is equally fine — verify by checking
that `public/` contains no `.env` rather than by the status code alone.

After `destroy`: project dir gone, no conf in `sites-enabled`, absent from
`SHOW DATABASES`, absent from `~/.agentpress/environments.json`. A dangling
hosts line is expected. Then `rewire` in a real site to restore your wiring.

## 3. Bump the version

Mandatory. npm refuses to republish an existing version with different
content, so an unbumped version cannot ship at all. Minor for new user-visible
behaviour or a new env var; patch for pure fixes.

Grep for the outgoing version in `SECURITY.md` too — it references specific
versions when disclosing what was broken and when.

## 4. Commit and merge

Branch, then merge to `main` with `--no-ff`.

## 5. Push

```bash
git push origin main
```

## 6. Publish — needs a real terminal

```bash
npm publish
```

2FA opens a browser; a non-TTY shell fails with `EOTP` and has no web fallback.
An agent cannot do this step.

**If it fails with a 404**, you are not authenticated — npm reports publish
permission failures as "not found". Check with `npm whoami` (it must print the
account that owns the package) and re-run `npm login`.

## 7. Verify the publish landed — two checks, not one

```bash
npm view create-agentpress version          # must be the new version
npm pack create-agentpress@X.Y.Z            # then grep the tarball
```

Check the **contents**, not just the number. A correct version over stale files
looks identical from the outside. *v1.1.0 was believed published and never
landed — auth had gone silently stale, and `npm view … versions` still shows the
gap: 1.0.0, 1.0.1, 1.2.0, …*

## 8. GitHub release

A push alone does not update the repo's advertised version.

```bash
gh release create vX.Y.Z --repo briansmith80/agentpress --target main \
  --title "AgentPress X.Y.Z — <summary>" --notes-file <notes.md>
```

Match the existing notes style: user-facing `##` sections explaining *why each
change matters*, and disclose known-broken behaviour rather than omitting it.

## 9. Update HANDOFF.md
