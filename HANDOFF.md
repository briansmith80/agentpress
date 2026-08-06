---
session_date: 2026-08-06T13:35:00Z
author: claude-code
operator: briansmith80
repo: briansmith80/agentpress
branch: main
base: main
status: done
handoff_reason: release-complete
---

# Handoff: v1.6.0 shipped — Oxygen `html-to-page` fixed, and sites that verify themselves

> **Maintainer session notes — not user documentation.** If you just cloned this repo, start
> at [README.md](README.md); for how to work in it, read [CLAUDE.md](CLAUDE.md); to release,
> follow [RELEASING.md](RELEASING.md). Nothing below is needed to *use* the tool.
>
> Earlier handoffs are archived under `.handoffs/`.

## TL;DR
> **v1.6.0 is live on npm and GitHub, verified both ways.** Two things shipped: the Oxygen
> `html-to-page` breakage — broken on *every* input for *every* Oxygen site — is now patched
> on install, and every scaffolded site gets an `AGENTS.md` plus a `/verify` command that
> exercises the whole stack and builds a holding page recording what passed. Nothing is in
> flight. The most useful next action is filing the Oxygen bug upstream, which is written and
> never sent.

## Objective / Goal
> Close the largest known user-facing breakage (Oxygen `html-to-page`) and make a scaffolded
> site able to prove its own stack works, rather than the user having to infer it from
> `claude mcp list`. **Definition of done: met, and verified by running it.**

## Current Status
> **Live and verified: `create-agentpress@1.6.0`.** Both release checks done — `npm view`
> reports 1.6.0, *and* the published tarball was downloaded and grepped: `template/AGENTS.md`,
> `template/.claude/commands/verify.md`, the patcher and the libxml fix string are all in the
> payload. GitHub release `v1.6.0` → `199f370`, which is `HEAD`.
>
> **Verified by running it, not by inspection:**
> - `html-to-page` A/B on a real site: reverted to the vendor original all three inputs fail
>   with `breakdance_html_to_page_parse_failed`; patched, all three pass.
> - The operator ran `/verify` in a fresh Claude Code session end to end — WordPress MCP,
>   Playwright MCP, Oxygen and abilities all PASS, holding page built.
> - A full fresh scaffold (`aptest160`) landed both agent files with placeholders resolved,
>   printed the new `/verify` pointer, and destroyed with zero residue.
> - 49 tests (was 37). Tarball assertion covers the new dot-directory.
>
> **Assumed, not verified:** Cursor/Codex/OpenCode paths, as always — only Claude Code is
> installed here.

## What Changed This Session
> - **Oxygen `html-to-page` patcher** (`patchOxygenHtmlToPage` in `src/plugins.mjs`). Runs
>   *after* `updateAllPlugins()` because that step re-fetches the vendor build and would undo
>   it; backfilled by `update`. The first time this tool edits code it did not write, so the
>   guards matter more than the patch — see Gotchas.
> - **`AGENTS.md` + `/verify`** scaffolded into every site (`template/`). The split is
>   deliberate: `AGENTS.md` is read every session so it is capped at 45 lines by a test;
>   `/verify` carries the procedure and the page markup and is loaded only when invoked.
> - **`/verify` discoverability**: scaffold summary, site menu, and after `rewire` — each
>   conditional, because suggesting a check that tests the MCP path when nothing is wired
>   sends the user at something designed to fail.
> - **`rewire` now says to restart an open agent session** — it mints a new application
>   password, so a running MCP server keeps the old one and 401s while `rewire` prints
>   "verified".
> - **README** rebuilt around the wordmark + install command; `tools/wordmark.mjs` generates
>   both SVGs from `src/ansi.mjs`; SECURITY.md discloses the vendor patch.

## Key Decisions & Rationale
> - **One page generator, not two.** An earlier plan had the CLI build a placeholder page and
>   the agent build a verified one, then asked how to stop them drifting — a problem created
>   entirely by the second generator. Cutting it also removed a shortcode, a mu-plugin, an
>   unverified "does Oxygen Text render shortcodes" dependency and a parity test. Cost: a site
>   where no agent is ever opened keeps WordPress's default homepage, i.e. today's behaviour.
> - **Only the agent can test the agent's path.** The CLI cannot verify MCP wiring (it *is*
>   the agent's config) and cannot reach Playwright at all. This is why `/verify` is a command
>   in the site rather than an `agentpress verify` subcommand.
> - **A test, not a demo.** `/verify` carries the exact markup so the same page comes out every
>   run with only the data differing. Let the agent design it freely and it stops being a
>   regression check.
> - **"MCP tools available", not "abilities registered".** The abilities count has four
>   different answers depending on how you ask (37 tools / 41 / 48 REST / 52 in PHP), so it
>   cannot signal breakage. The tool count is what the agent can actually call, and `rewire`
>   prints the same number.
> - **Rejected:** a paste-able prompt with no files (unrepeatable, and the long HTML makes it
>   unwieldy); `CLAUDE.md` as well as `AGENTS.md` (duplicate); speculative `/audit`,
>   `/new-page` commands.

## Files Touched
| Path | Change | Why it matters |
|------|--------|----------------|
| `src/plugins.mjs` | `patchOxygenHtmlToPage` + `libxmlVersion` | The vendor patch and every guard on it. Read the block comment before touching. |
| `src/engine.js` | patcher call sites, `/verify` pointers, `rewire` restart hint | Patcher runs after `updateAllPlugins` (scaffold) and in `updateCommand` (backfill). |
| `template/AGENTS.md` | NEW | Always-loaded agent context. **45-line cap enforced by a test** — move things into a command rather than raising it. |
| `template/.claude/commands/verify.md` | NEW | The procedure + the page markup. Lazy-loaded, so length is cheap here. |
| `tools/wordmark.mjs` | NEW | Regenerates both SVGs from `src/ansi.mjs`. Not shipped in the tarball. |
| `test/vendor-patch.test.mjs`, `test/agent-files.test.mjs` | NEW | 12 tests, mostly pinning *refusals*. |
| `test/assert-tarball.mjs` | MODIFIED | Now requires the two new template files. |
| `SECURITY.md`, `README.md`, `template/README.md` | MODIFIED | Vendor patch disclosed; `/verify` documented. |

## Commands & Environment to Reproduce
> ```bash
> npm test                    # 49 tests, ~10s, no Laragon needed
> npm run check
> node test/assert-tarball.mjs
> node index.js doctor        # exit 0; AGENTPRESS_LARAGON_ROOT=C:/nope … → exit 1
> ```

## How to Verify / Test
> 1. The four commands above — the fast gate.
> 2. **`/verify` in a scaffolded site** is now the end-to-end check. `update` first if the
>    site predates 1.6.0.
> 3. The Oxygen patch, on a site with Oxygen:
>    `grep "xml encoding" public/wp-content/plugins/oxygen/plugin/mcp/design/html-to-page.php`
> 4. Full scaffold recipe and residue checklist: `RELEASING.md` step 2.

## Open Questions / Blockers
> - **[ACTION, unsent] The Oxygen bug has still not been reported upstream.** File at
>   `soflyy/agent-connector-for-wp` (Issues enabled; five live Oxygen 6.2 MCP bugs already
>   there) — *not* `oxygen-bugs-and-features`, which is Oxygen Classic only. Lead with the
>   libxml version: their CI likely runs < 2.10, which is probably why it shipped. Draft and
>   full diagnosis in `PLANNING/TODO.md`. Posts publicly under the operator's identity, so it
>   is deliberately a manual step.
> - **[INACCURACY, in git history]** The `199f370` release commit message credits 1.6.0 with
>   the admin-link scheme fix, the `safeHost` port fix and the `'C:\Windows'` fix. **All three
>   shipped in v1.3.0** (`726f22e`). The GitHub release notes are correct; the commit message
>   is not, and was left rather than rewriting pushed history.
> - **[QUESTION] Cursor CLI detection is probably stale** — `src/agents.mjs` probes
>   `cursor-agent`; an audit claims the shipped Windows binary is now `agent`. Unverified.
> - **[CHORE] `git remote` still points at the old repo name** (`katalyst-laragon`) and relies
>   on GitHub's redirect: `git remote set-url origin https://github.com/briansmith80/agentpress.git`
> - **[CHORE] Mixed line endings.** `src/` is LF, `README.md`/`template/` are CRLF; every
>   commit prints warnings. A `.gitattributes` would end it.

## Next Steps (ordered, actionable)
> 1. [ ] File the Oxygen bug upstream (see Blockers — the only outstanding item from this work).
> 2. [ ] Confirm or fix the Cursor CLI binary name, then wire it (`src/agents.mjs`
>    `AGENT_COMMANDS`, plus the frozen menu's copy — `test/parity.test.mjs` catches drift).
> 3. [ ] Add `.gitattributes`; set the git remote to the current repo name.
> 4. [ ] Still unfixed from the original audit: progress output during the multi-minute
>    download steps (a stuck run and a slow run look identical); an `info`/`open` command; a
>    `snapshot`/`rollback` pair via `wp db export`; `WP_DEBUG` on by default;
>    `src/secrets.mjs` truncating to ~41 bits of entropy; the scaffold summary printing the
>    admin password to stdout even when an agent is capturing it.

## Git State
> - Branch `main`, pushed, level with `origin/main`. Last commit `199f370`.
> - Tags: `v1.6.0` → `199f370`. GitHub release published and marked latest.
> - Uncommitted: this handoff only.
> - npm: 1.0.0, 1.0.1, 1.2.0, 1.3.0, 1.4.0, 1.5.0, **1.6.0**. (1.1.0 is a permanent gap.)

## Context & Gotchas
> - **The vendor patch is the one place this tool edits code it did not write.** Every branch
>   either matches an exactly-known string or refuses aloud. Do not make it fuzzy-match. Five
>   tests pin the *refusals*, which matter more than the patch.
> - **`npm whoami` was E401 immediately before this release.** The operator re-authenticated.
>   Check it *before* publishing — npm reports a publish auth failure as `404 Not Found`, and
>   this is exactly how v1.1.0 vanished.
> - **`node --check` cannot see an undefined identifier, and neither can a module-load test.**
>   `AGENT_LABELS` was used in `engine.js` without importing it; both passed. An unimported
>   name inside a function body only throws when that function runs — and that one runs at the
>   end of every successful scaffold. Only a real scaffold caught it.
> - **Block art rendered as *text* is not portable.** The holding-page wordmark ran together in
>   the browser even with `white-space:pre`, a genuinely monospaced font, and all five lines at
>   the right lengths — `U+2588`'s drawn width does not match the character advance in every
>   font. It is an SVG now. The CLI banner is fine; terminals are a fixed grid.
> - **`--premium=none` sites expose only THREE MCP tools** (the generic adapter ones) — no
>   `get-instructions`, no `html-to-page`. `/verify` and `AGENTS.md` both branch on this.
>   Found by scaffolding one; it would have failed at step 1 for those users.
> - **`update` writes under `public/` in exactly two places**: the loopback guard (ours) and
>   the Oxygen patch (not ours). Anything else under `public/` is off limits.
> - **Secrets**: no generated password, application password, licence key or admin-login token
>   from this session appears in this file or in git.
