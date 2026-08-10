---
session_date: 2026-08-10T16:00:23Z
author: claude-code
operator: briansmith80
repo: briansmith80/agentpress
branch: main
base: main
status: ready-to-publish
handoff_reason: 1.8.0 complete on main, needs a real terminal to publish
---

# Handoff: v1.8.0 is complete on `main` and UNPUBLISHED — the whole audit roadmap landed

> **Maintainer session notes, not user documentation.** If you just cloned this repo, start
> at [README.md](README.md); for how to work in it, read [CLAUDE.md](CLAUDE.md); to release,
> follow [RELEASING.md](RELEASING.md). Nothing below is needed to *use* the tool.
>
> Earlier handoffs are archived under `.handoffs/`.

## TL;DR
> **v1.7.0 and v1.7.1 shipped earlier this session** (MCP 401 diagnosis; two `/verify` fixes).
> Then a 13-agent audit produced 72 verified findings, and **all five steps of its roadmap are
> now implemented, live-tested and merged to `main` as v1.8.0.**
>
> **The one thing left is `npm publish`**, which needs a real terminal for 2FA. Nothing is in
> flight. 93 tests pass, `doctor` exits 0 and 1 correctly, tarball clean.
>
> Full audit report (all 72 findings, themes, what was judged not worth doing):
> https://claude.ai/code/artifact/acff6422-d49f-4cc4-8d4d-0ee36bd54c60

## What v1.8.0 contains, in the order it was built
> Each step was its own branch, merged `--no-ff`, with its own live test.
>
> **1. Safety (`fix/argv-and-resume-safety`).** Three ways a user lost work, all the same
> shape: a target taken from cwd or argv with no check, and `--yes` removing the only
> confirmation. `destroy other-site --yes` deleted the folder you were standing IN;
> `resume <name>` adopted any folder with a `public\` and no `.env` (also the shape of a
> cloned project with a gitignored `.env`) and overwrote it; `--premium none` (space, not `=`)
> installed EVERY licensed commercial plugin. All refuse now, with `--adopt` and
> `--force-name` as documented overrides. `closestCommand` had to tighten in the same change
> because it now gates a refusal and previously matched `test`/`host`/`best`/`hello`.
>
> **2. Text (`fix/text-pass`).** `agentpress <cmd>` is not a command this package installs —
> five frozen files said it was, at the 401 recovery moment. Plus one unified wrong-folder
> refusal (three existed and all three disagreed), `list`'s empty state, `printUsage`, the
> `/verify` holding-page caveat, and **four false `SECURITY.md` claims**, each traced to code
> rather than taken from the audit.
>
> **3. Panel honesty (`fix/panel-honesty`).** `✓ WordPress is ready` printed while five
> computed failure signals were discarded. Now a warnings list inside the panel.
>
> **4. Polish (`fix/polish-pass`).** `setup` installs the required wildcard vhost BEFORE the
> optional prompts (abandoning the licence question used to cost it silently); five doctor rows
> corrected; the https scheme is token-proven; `psQuote` on the hosts temp path; the libxml
> null skip is reported; `--verbose` removed; the `index.js` error formatter; MySQL preflight
> gates; frozen-menu `envOn` + numeric version compare; four new parity assertions.
>
> **5. Version awareness + teardown + plugins.** `list` gains VERSION and an MCP-target
> marker; `update --all`; an older CLI refuses to downgrade a newer site; `destroy` HALTS
> rather than orphaning a database it could not drop; one bad `--plugins` slug no longer sinks
> a working scaffold.

## Read this before touching anything: three wrong conclusions in one session
> All three survived careful code reading and died on contact with a real run. This is now
> also recorded in CLAUDE.md, and each has a test that fails when the bug returns —
> **verified by reintroducing it, not assumed.**
>
> 1. **"WordPress wipes the `.htaccess` Authorization rule on a hard flush."** False. Core
>    emits an identical rule itself (`class-wp-rewrite.php`, `mod_rewrite_rules()`). Proven by
>    reproducing a real flush: authenticated REST returned 200 before and after.
> 2. **A comment quoting `# BEGIN WordPress` inside our own block corrupted the file**, because
>    core matches markers with `str_contains()` per LINE. Review, `node --check` and 49 tests
>    all passed. `assertNoWordPressMarker` now refuses to write such a block.
> 3. **`--output-dir` on `@playwright/mcp` looked like a complete fix.** Driving the server
>    over stdio showed it governs only the DEFAULT filename; an explicit relative `filename`
>    escapes it. `/verify` therefore also tells agents not to name the screenshot.

## Next steps (ordered, actionable)
> 1. [ ] **`npm publish`** from a real terminal. Check `npm whoami` FIRST — npm reports a
>    publish auth failure as `404`, which happened again on the 1.7.0 publish this session.
> 2. [ ] Then both release checks from CLAUDE.md step 6: `npm view create-agentpress version`,
>    and `npm pack create-agentpress@1.8.0` + grep the tarball for `AGENTPRESS_DEBUG`,
>    `update --all`, and `npx create-agentpress@latest rewire` in `template/AGENTS.md`.
> 3. [ ] `gh release create v1.8.0` — the notes want to lead with the three destructive-path
>    refusals and the `agentpress` command correction, since those affect existing users.
> 4. [ ] Ask the friend to upgrade and re-run `rewire` in `smit-oxy`; the 401 diagnosis now
>    names the cause. Still the only outstanding field question.
> 5. [ ] File the Oxygen `html-to-page` bug upstream (unchanged, still never sent).
> 6. [ ] Cursor CLI binary name (`cursor-agent` vs `agent`) — still unverified.
> 7. [ ] `.gitattributes` for the CRLF warnings; `git remote` still uses the old repo name.

## Open questions / known-unfixed
> - **[FOUND, NOT FIXED] `acquireScaffoldLock` is more stealable than its comments claim.**
>   While trying to force lock contention, a scaffold proceeded with (a) a lock naming a live
>   foreign pid (4/System) and (b) a DIRECTORY at the lock path. Two throwaway sites were
>   created accidentally and torn down. Worth a look; deliberately not in the 1.8.0 plan.
> - **[QUESTION] The 72-finding audit had 0 outright rejections.** 40 CONFIRMED, 32 CORRECTED.
>   For an adversarial pass told to reject freely that is lenient, so the low-severity tail
>   deserves more suspicion than the six high-severity items, which were re-verified by hand.
> - The Oxygen `html-to-page` break still ships from the cached premium zip.
> - `AGENTPRESS_NO_VENDOR_PATCH` is called for in `PLANNING/TODO.md` and implemented nowhere.
>   Verified 2026-08-10: it appears in no source file, no help text and no README, so no user
>   was ever promised it. The audit's claim that it was "promised in help and the README" was
>   wrong.

## Git / release state
> - Branch `main`, pushed, level with `origin/main`. Working tree clean apart from this file.
> - `package.json` is **1.8.0, UNPUBLISHED**. npm's latest is 1.7.1.
> - Tags: `v1.7.0` → `12be5b1`, `v1.7.1` → `2e88cde`. No tag for 1.8.0 yet.
> - npm: 1.0.0, 1.0.1, 1.2.0, 1.3.0, 1.4.0, 1.5.0, 1.6.0, 1.7.0, **1.7.1**. (1.1.0 is a gap.)
> - 15 commits this session, `3a4eac0..HEAD`.

## Context & gotchas
> - **`agentpress` is NOT a command.** `package.json` ships one bin, `create-agentpress`, and
>   the decision was NOT to add an alias. Inside a site, `agentpress` is only an npm *script*
>   (`npm run agentpress`). A test now pins both the template strings and the single-bin rule.
> - **WordPress matches `.htaccess` markers with `str_contains()` per LINE.** Never put that
>   text in our block, not even in a comment. Guarded at write time plus two tests.
> - **npm reports a publish auth failure as `404 Not Found`.** Third occurrence. Check
>   `npm whoami` before publishing; this is how v1.1.0 vanished.
> - **`wp` is not on PATH in Git Bash here.** Use `php /c/laragon/usr/bin/wp-cli.phar`. A
>   `$(wp …)` expanding to empty sends an empty password and yields a completely genuine 401.
> - **Do not mutation-test guards by letting the argv through the real dispatcher.** Doing that
>   scaffolded a site called `destory` — folder, database, user, registry entry and a
>   re-pointed machine-global MCP wiring. `refuseInvocation` is pure precisely so the same
>   check is now a string comparison.
> - **Live-test hygiene held throughout**: `~/.claude.json`'s `mcpServers` snapshotted before
>   every scaffold and restored after (currently `agentpress-test-website-latest.test`);
>   `~/.agentpress/environments.json` backed up and restored when `update --all` was tested
>   against throwaway dirs, so the operator's two real sites were never touched. All test
>   sites destroyed, databases/users/registry entries confirmed gone. Dangling hosts lines for
>   `aptest901/902/903/908/909/910/911/913/914` and `destory` remain, as documented.
> - **Secrets**: no generated password, application password, licence key or admin-login token
>   from this session appears in this file or in git.
