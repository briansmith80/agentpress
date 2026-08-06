# __PROJECT_NAME__ — agent notes

AgentPress-scaffolded WordPress + Oxygen site, served by Laragon at
__SITE_SCHEME__://__SITE_HOST__. WordPress lives in `public/`.

Two MCP servers are wired: **wordpress** (this site's REST API — build and edit
pages with the Oxygen tools) and **playwright** (a real browser — load what you
built and look at it instead of assuming the markup is right).

## Building pages

Call `get-instructions` first; the server requires it. Author semantic HTML with
a `<style>` block and pass it to `html-to-page`. Use `edit-post` and the
`set-element-*` tools for fine-grained edits and anything HTML can't express.

Three things fail **silently** — no error, just a wrong-looking page:

- `<style>` must use **class selectors only**. Bare tag selectors (`h1 { }`) and
  inline `style=""` are dropped without warning.
- An `@media` query is imported only if copied **verbatim** from
  `get-breakpoints`. Invented or rounded queries are discarded, leaving a
  desktop-only layout.
- Class names not defined in the `<style>` block are dropped from elements.

So: after building anything, load it with Playwright and look at it.

## Commands

`npm run agentpress` opens the site menu; `npm run wp -- <cmd>` runs wp-cli.
wp-admin needs no password — the menu mints a one-time link, single-use and
~5 minutes, so mint a fresh one rather than reusing an earlier one.

## Gotchas

- Credentials are in `.env` — gitignored and not served. Never copy it into
  anything served or committed.
- MCP wiring is machine-global: scaffolding another site repoints it away from
  this one, and `agentpress rewire` here points it back. **401s mean this.**
- To check the whole stack, run `/verify`, or follow
  `.claude/commands/verify.md` — any agent can read it.
