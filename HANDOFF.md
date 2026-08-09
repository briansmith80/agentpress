---
session_date: 2026-08-07T16:52:49Z
author: claude-code
operator: briansmith80
repo: briansmith80/agentpress
branch: main
base: main
status: done
handoff_reason: release-complete
---

# Handoff: v1.7.0 and v1.7.1 shipped — MCP 401s now say what is wrong, and `/verify` works

> **Maintainer session notes, not user documentation.** If you just cloned this repo, start
> at [README.md](README.md); for how to work in it, read [CLAUDE.md](CLAUDE.md); to release,
> follow [RELEASING.md](RELEASING.md). Nothing below is needed to *use* the tool.
>
> Earlier handoffs are archived under `.handoffs/`.

## TL;DR
> **v1.7.0 is live on npm and GitHub, verified both ways.** A user reported `rewire` printing
> a 401 and then, as the only actionable line on screen, "restart your agent session" —
> advice that is correct for one cause and misleading for every other. AgentPress now asks
> the site why the credential was rejected and prints the cause with its own fix.
>
> **v1.7.1 followed**, fixing two `/verify` bugs reported from a real run: instructions that
> asked the Oxygen page tools for a `slug` neither of them has, and Playwright writing
> screenshots into the site folder. Both live on npm and GitHub, verified both ways. Nothing
> is in flight.
>
> **Read the correction below before acting on anything about `.htaccess`.** The session
> started from a confident diagnosis that turned out to be wrong, and the live test is what
> caught it. The same thing happened twice more: the `--output-dir` fix was half a fix, and
> the marker-collision bug. In all three cases running it is what found it.

## The correction, because it will otherwise be re-derived
> **Claim made early in the session:** WordPress wipes the Authorization passthrough from
> `.htaccess` on any hard rewrite flush, so every AgentPress site eventually loses MCP auth.
>
> **That is wrong, and it was wrong in a plausible way.** The mechanism is real:
> `flush_rewrite_rules()` defaults to hard, reaches `save_mod_rewrite_rules()` →
> `insert_with_markers($file, 'WordPress', $rules)`, and replaces everything between
> `# BEGIN WordPress` / `# END WordPress` with core's own generated rules. Core even stamps
> "Any changes to the directives between these markers will be overwritten" into the result.
>
> **But core's generated rules already contain an identical passthrough** —
> `class-wp-rewrite.php`, `mod_rewrite_rules()`, third line of the block. A flush swaps our
> copy for core's equivalent and auth keeps working. **Verified by reproducing a genuine hard
> flush against a scaffolded site: authenticated REST returned 200 before and 200 after.**
>
> So: saving Settings ▸ Permalinks does not break MCP auth, this is not a latent problem for
> other users, and the placement was redundant rather than fragile. The rule was moved into
> the AgentPress block anyway, as a tidy-up, and the release notes say exactly that.

## Current Status
> **Live and verified: `create-agentpress@1.7.0`.** Both release checks done — `npm view`
> reports 1.7.0, *and* the published tarball was downloaded and grepped: `diagnoseAppPasswordAuth`,
> `HTACCESS_AUTH_MARKER`, `assertNoWordPressMarker` and `ensureHtaccessGuardBlock` are all in
> the payload across `src/engine.js`, `src/wordpress.mjs` and `src/doctor.mjs`. GitHub release
> `v1.7.0` → `12be5b1`, published and marked latest.
>
> **1.7.1 is also live, verified both ways.** `npm view` reports 1.7.1, and the downloaded
> tarball carries `--output-dir`/`PLAYWRIGHT_OUTPUT_DIR` in `src/mcp.mjs` plus both new
> `/verify` rules and the `.playwright-mcp/` gitignore entry. GitHub release `v1.7.1` →
> `2e88cde`, published and marked latest. It began as a test-only delta and picked up two
> `/verify` fixes reported from a real run — see below.

## What Changed This Session
> - **`diagnoseAppPasswordAuth`** (`src/wordpress.mjs`). On a 401/403 from the endpoint probe,
>   asks the site which of three causes it is and returns hints, each carrying its own fix:
>   no Authorization passthrough in `.htaccess`; `wp-config.php` missing
>   `WP_ENVIRONMENT_TYPE=local`; a plugin filtering `wp_is_application_passwords_available`
>   off. Silent when it finds nothing — no hint beats an invented one.
> - **The session-restart line is now conditional** (`rewire`, `src/engine.js`). It prints only
>   when verification passed. It was previously unconditional, which is the whole bug report.
> - **`rewire` repairs before it mints** via `ensureHtaccessGuardBlock`. A site that cannot
>   authenticate is fixed rather than handed a credential it must reject.
> - **`doctor` sweeps every AgentPress site** for a missing passthrough. Matches the RULE, not
>   our wording, so a site whose file WordPress regenerated is correctly left alone. Row
>   appears only when there is something to fix.
> - **Authorization rule moved** out of WordPress's marker block into the AgentPress block.
>   Tidy-up, not a fix — see the correction above.
> - **`assertNoWordPressMarker`** — a write-time guard, see Gotchas. This is the important one.
> - **`test/htaccess.test.mjs`** — 5 new tests (49 → 54).
> - **CLAUDE.md corrected**: it claimed "there is **no automated test suite**", which has been
>   false since 1.6.0 and cost real time this session.

## Then: two `/verify` bugs, both from one field run (shipped in 1.7.1)
> An operator ran `/verify` in a scaffolded Oxygen site and reported two things. Both were
> real, and one of my two initial readings of them was wrong.
>
> - **`/verify` asked for a slug-based page lookup the MCP surface cannot do.** Step 3 said
>   "look for a page with the slug `home`". `search-posts` has no slug filter (titles and
>   content only) and `create-post`'s entire schema is `title`, `status`, `content`,
>   `post_type`, `parent_id`. The agent invented the `slug` parameter it had been asked for
>   and the call was rejected. Step 3 now names both limits outright.
> - **Playwright wrote into the site folder.** Wired with no flags, `@playwright/mcp` puts
>   screenshots and page snapshots in `.playwright-mcp/` under the agent's cwd. Now wired with
>   `--output-dir` at an absolute temp path.
> - **Correction to the report:** it was described as landing in "the served site folder". At
>   the project root it is not served — the docroot is `public/`, which `curl …/.env` → 404
>   already proves. It is served only if the agent was started inside `public/`. Litter in the
>   normal layout, exposure only in that one.
> - **`--output-dir` is half a fix, and only running it showed that.** Driving the server over
>   stdio: the flag governs the DEFAULT filename, but an explicit *relative* `filename`
>   resolves against the agent's cwd and escapes the output dir completely. So step 4 also
>   tells agents not to name the screenshot, and one test pins the flag and the instruction
>   together — deleting either alone silently restores the bug.

## Key Decisions & Rationale
> - **Diagnose, do not guess.** The deliverable was never a `.htaccess` fix; it is that the
>   output now names the cause. That framing survived the diagnosis being wrong, which is the
>   sign it was the right frame.
> - **Each hint carries its own fix.** The first draft printed one shared footer saying
>   "repair with `update`" — untrue for two of three causes, and it would have reproduced the
>   wrong-advice problem one layer down. Caught by reading the live output, not the code.
> - **Kept the `.htaccess` move after learning it fixes nothing.** It is live-verified neutral,
>   it puts the copy we are responsible for in the block we own, and the notes describe it
>   honestly as a tidy-up. Reverting would have been equally defensible; the operator was
>   offered the choice.
> - **Bumped to 1.7.1 rather than leaving `main` at a published version number.** `main` ahead
>   of npm is normal. `main` equal-but-different is how a future publish silently fails.

## Files Touched
| Path | Change | Why it matters |
|------|--------|----------------|
| `src/wordpress.mjs` | `diagnoseAppPasswordAuth`, `ensureHtaccessGuardBlock`, `assertNoWordPressMarker`, `HTACCESS_AUTH_MARKER`, guard block content | The core of the change. Read `assertNoWordPressMarker`'s comment before editing the block's comments. |
| `src/engine.js` | 401 diagnosis call, hint printing, conditional restart line, `rewire` pre-repair | The user-visible behaviour. |
| `src/doctor.mjs` | `sitesMissingAuthPassthrough` + conditional row | Machine-wide sweep. Identified by our marker, never by "folder in `www\`". |
| `test/htaccess.test.mjs` | NEW | 5 tests. Two pin the marker invariant; verified to fail when the bug is reintroduced. |
| `CLAUDE.md` | "no test suite" claim corrected | It was stale and actively misleading. |

## Commands & Environment to Reproduce
> ```bash
> npm test                    # 54 tests, ~12s, no Laragon needed
> npm run check
> node index.js doctor        # exit 0; AGENTPRESS_LARAGON_ROOT=C:/nope … → exit 1
> ```
> The clobber reproduction (the test that actually mattered) is `save_mod_rewrite_rules()`
> minus its `got_mod_rewrite()` gate, run through `wp eval-file`. That gate is SAPI detection
> only, which is why WP-CLI cannot normally rewrite `.htaccess` and why the damage only ever
> arrives through a real Apache request:
> ```php
> require_once ABSPATH . 'wp-admin/includes/misc.php';
> $rules = explode( "\n", $GLOBALS['wp_rewrite']->mod_rewrite_rules() );
> insert_with_markers( ABSPATH . '.htaccess', 'WordPress', $rules );
> ```

## How to Verify / Test
> 1. `npm test` + `npm run check` + `doctor` both ways — the fast gate.
> 2. Scaffold, then probe auth over loopback before and after the clobber above. Both 200.
>    `curl.exe --user "admin:<app-pw>" -H "Host: <site>.test" http://127.0.0.1/wp-json/wp/v2/users/me`
> 3. Each diagnosis branch, all exercised live this session: strip `E=HTTP_AUTHORIZATION` from
>    `.htaccess` (→ real 401, `doctor` names the site, `rewire` self-repairs); comment out
>    `WP_ENVIRONMENT_TYPE` (→ correct hint); drop an mu-plugin returning false from
>    `wp_is_application_passwords_available` (→ correct hint).
> 4. `wp` is **not on PATH in Git Bash** on this machine. Use `php /c/laragon/usr/bin/wp-cli.phar`.
>    A `$(wp …)` that silently yields an empty string produces a very convincing false 401.

## Open Questions / Blockers
> - **[QUESTION] The reported site's actual cause is still unknown.** `smit-oxy` on a friend's
>   machine (`E:\garage\laragon\www\smit-oxy`), Oxygen, v1.6.0. The `.htaccess` hypothesis is
>   mostly eliminated. Most likely `WP_ENVIRONMENT_TYPE` or a plugin. **They should upgrade and
>   re-run `rewire`, which now just tells them.** No follow-up has come back yet.
> - **[ACTION, unsent] The Oxygen bug has still not been reported upstream.** Unchanged from
>   the last two handoffs. File at `soflyy/agent-connector-for-wp`; draft and full diagnosis in
>   `PLANNING/TODO.md`. Posts publicly under the operator's identity, so it stays manual.
> - **[NOTE] The new Playwright wiring needs `rewire`, not `update`.** `update` refreshes the
>   `/verify` instructions but not the machine-global MCP config, so existing sites keep
>   writing `.playwright-mcp/` into the project until someone runs `rewire` in them. This is
>   why `.playwright-mcp/` is in the template gitignore as well as being fixed at the source.
> - **[QUESTION] Cursor CLI detection is probably stale** — `src/agents.mjs` probes
>   `cursor-agent`; an audit claims the shipped Windows binary is now `agent`. Unverified.
> - **[CHORE] `git remote` still points at the old repo name** (`katalyst-laragon`) and relies
>   on GitHub's redirect.
> - **[CHORE] Mixed line endings.** A `.gitattributes` would end the per-commit warnings.

## Next Steps (ordered, actionable)
> 1. [ ] Ask the friend to `npm i -g create-agentpress@latest`, run `agentpress update` then
>    `agentpress rewire` in `smit-oxy`, and report what the diagnosis says. That closes the
>    loop and tells us whether the three causes are the right three.
> 2. [ ] File the Oxygen bug upstream (see Blockers).
> 3. [ ] Confirm or fix the Cursor CLI binary name (`src/agents.mjs` + the frozen menu's copy;
>    `test/parity.test.mjs` catches drift).
> 4. [ ] Add `.gitattributes`; set the git remote to the current repo name.
> 5. [ ] Still unfixed from the original audit: progress output during multi-minute downloads;
>    an `info`/`open` command; a `snapshot`/`rollback` pair; `WP_DEBUG` on by default;
>    `src/secrets.mjs` truncating to ~41 bits of entropy; the scaffold summary printing the
>    admin password to stdout even when an agent is capturing it.

## Git State
> - Branch `main`, pushed, level with `origin/main`.
> - `12be5b1` = merge of `fix/mcp-401-diagnosis`, tagged `v1.7.0`, GitHub release latest.
> - Tags: `v1.7.0` → `12be5b1`, `v1.7.1` → `2e88cde` (latest).
> - npm: 1.0.0, 1.0.1, 1.2.0, 1.3.0, 1.4.0, 1.5.0, 1.6.0, 1.7.0, **1.7.1**. (1.1.0 is a permanent gap.)
> - `package.json` on `main` is **1.7.1**, published.

## Context & Gotchas
> - **WordPress matches its `.htaccess` markers with `str_contains()` per LINE.** Not an
>   equality test, not anchored. So *any* occurrence of that text in our block — including
>   inside a comment — is read as core's opening marker, and everything after it gets
>   swallowed on the next flush. v1.7.0's first build shipped exactly that: a comment reading
>   `above "# BEGIN WordPress"`. Review passed, `node --check` passed, every unit test passed,
>   and it destroyed half the file on the first real flush. There is now
>   `assertNoWordPressMarker` (fails safe at write time) **and** two tests, both confirmed to
>   fail when the bug is reintroduced. **This is the single most important thing on this page.**
> - **npm reports a publish auth failure as `404 Not Found`, not `401`.** Hit again this
>   session on the 1.7.0 publish (`E404 … PUT https://registry.npmjs.org/create-agentpress`).
>   The operator re-authenticated and it went through. Third occurrence; check `npm whoami`
>   *before* publishing. This is how v1.1.0 vanished.
> - **The unit suite cannot see composed-output bugs, by construction.** Both real defects this
>   session — the marker collision and the wrong "repair with `update`" footer — were found by
>   reading live output. CLAUDE.md now says so.
> - **`wp` is not on PATH in Git Bash here.** `$(wp …)` expands to empty, Basic auth then sends
>   an empty password, and the site returns a completely genuine 401. This wasted a cycle and
>   very nearly produced a false conclusion about the fix.
> - **`update` writes under `public/` in exactly three places now**: the loopback guard, the
>   Oxygen patch, and the `.htaccess` guard block (same splice as the guard). Anything else
>   under `public/` is off limits.
> - **Live-test hygiene held**: `~/.claude.json` `mcpServers` snapshotted before scaffolding and
>   restored after (back to `kezzie.test`); `aptest901`/`aptest902` destroyed; project dirs,
>   vhost confs, databases and registry entries all confirmed absent. Hosts lines remain, as
>   documented.
> - **Secrets**: no generated password, application password, licence key or admin-login token
>   from this session appears in this file or in git.
