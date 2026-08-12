---
session_date: 2026-08-12T09:30:00Z
author: claude-code
operator: briansmith80
repo: briansmith80/agentpress
branch: main
base: main
status: done
handoff_reason: awaiting-operator-manual-test
---

# Handoff: hosts removal root-caused and rebuilt after emptying the file — 1.9.0 ready, UNPUBLISHED

> **Maintainer session notes, not user documentation.** If you just cloned this repo, start
> at [README.md](README.md); for how to work in it, read [CLAUDE.md](CLAUDE.md); to release,
> follow [RELEASING.md](RELEASING.md). Nothing below is needed to *use* the tool.
>
> Earlier handoffs are archived under `.handoffs/`.

## TL;DR (2026-08-12)
> **`main` is at 1.9.0, NOT published, by the operator's explicit instruction** — they run a
> manual create-to-destroy pass before any publish. Do not publish or tee it up.
>
> **The hosts incident, root-caused.** The first `destroy`-removes-the-hosts-entry attempt
> (briefly on `main` as d368040) left this machine's hosts file **0 bytes** — restored
> byte-identical from a backup, feature reverted (04ffc42). This session established the
> mechanism: `Get-Content -ErrorAction SilentlyContinue` returns NOTHING on a failed read,
> the filter over zero lines yielded an empty result, and `Set-Content` persisted it — and
> the read had every chance to fail, because destroy had just deleted a www folder, which is
> when Laragon rewrites the whole hosts file from a temp copy. Laragon "can do it" because it
> is one process that never persists a failed read.
>
> **v2 shipped to `main` as 1.9.0** (`hostsRemovalScript`/`removeHostsEntries` in
> `src/wildcard.mjs`): .NET reads that throw, abort on empty, only lines tagged exactly
> `#agentpress` are removable, caller-computed cap, temp-file + rename, post-write verify
> with restore from a byte-verified backup, and it runs BEFORE the folder delete. The append
> also now only adds a newline separator when the file needs one (the doubled blank lines the
> operator reported are gone, and removal collapses the old ones). 113 tests; 13 of them
> drive the REAL script bytes through PowerShell against temp fixtures, each pinning one
> guard. Live-verified on the real machine: append→remove **byte-identity round-trip**, then
> the 9 stale entries cleared in one elevated run (80 `#laragon magic!` lines untouched).
>
> **Also since 1.8.1:** transactional destroy (halts before deleting anything the .env still
> describes when the DB drop fails, with recovery SQL), EBUSY teardown diagnosis corrected
> (editor/language-server race, not the shell's cwd), the `--yes` SSL Stop All → Start All
> notice, and the doctor/registry/update-all work — see the sections below and `git log
> f972509..`.

## TL;DR as of v1.8.1 (2026-08-10)
> **v1.7.0 and v1.7.1 shipped earlier this session** (MCP 401 diagnosis; two `/verify` fixes).
> Then a 13-agent audit produced 72 verified findings, and **all five steps of its roadmap are
> now implemented, live-tested and merged to `main` as v1.8.0.**
>
> **v1.8.0 is live on npm and GitHub, verified both ways.** `npm view` reports 1.8.0, and the
> published tarball was downloaded and grepped for one marker per step: refuseInvocation,
> agentPressMarkers, the npx rewire string in template/AGENTS.md, the panel warnings list,
> AGENTPRESS_DEBUG, updateAllProjects and destroy's halted flag. All present. GitHub release
> `v1.8.0` published and marked latest. 93 tests passed at that point.
>
> **v1.8.1 followed and is also live, verified both ways.** It fixes a field report: `/verify`
> was seeding 11 GLOBAL Oxygen selectors named `ap-*` into every site — and Oxygen DERIVES
> `ap-` as the recommended prefix for a site called e.g. "Acme Plumbing", so that was the
> user's namespace, and an import replaces a same-named selector outright. Renamed to
> `agentpress-verify-*`, disclosed every run, plus a refusal to delete selectors and two false
> doc claims corrected. 97 tests, CI green. Nothing is in flight.
>
> **CI was red for six pushes during this work and nobody noticed** — see Context & gotchas.
> The published 1.8.0 is NOT affected: the failure was in a test, and `test/` is not in the
> files allowlist, so no shipped code was involved.
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
> -1. [ ] **Wait for the operator's manual create-to-destroy pass, then publish 1.9.0**
>    (steps 5–8 of CLAUDE.md's release order: `npm publish` from a real terminal, verify
>    version AND tarball contents, GitHub release, HANDOFF). Their teardown feedback drove
>    this whole arc; their pass on 2026-08-12 found four defects the suite did not.
> 0. [ ] **The one verification 1.8.1 is missing.** CLAUDE.md's live test for that change is
>    "scaffold a throwaway, run `/verify`, confirm the page renders styled and that
>    `get-css-selectors` shows 11 `agentpress-verify-*` names and no `ap-*`". Only the scaffold
>    half was done: the renamed classes are verified as text that reaches a site correctly, NOT
>    as CSS Oxygen registers under the new names. Needs one `/verify` run in a site with Oxygen,
>    from an agent session (this session's `wordpress` MCP was 401ing on stale credentials).
>    Conveniently the same run answers item 1.
> 1. [ ] Ask the friend to upgrade and re-run `rewire` in `smit-oxy`; the 401 diagnosis now
>    names the cause. Still the only outstanding field question, and the one that tells us
>    whether the three causes it knows about are the right three.
> 2. [ ] File the Oxygen `html-to-page` bug upstream at `soflyy/agent-connector-for-wp`.
>    Written, never sent, unchanged across four handoffs now. Draft in `PLANNING/TODO.md`.
> 3. [ ] Confirm or fix the Cursor CLI binary name (`cursor-agent` vs `agent`) in
>    `src/agents.mjs` plus the frozen menu's copy — `test/parity.test.mjs` catches drift.
> 4. [ ] `acquireScaffoldLock` (see Open questions) — it is more stealable than documented.
> 5. [ ] Add `.gitattributes` to end the CRLF warnings; point `git remote` at the current
>    repo name instead of relying on GitHub's redirect.

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
> - Branch `main`, pushed, level with `origin/main`.
> - `package.json` is **1.9.0, UNPUBLISHED — operator manual-tests before any publish.**
> - npm latest is **1.8.1**. 1.8.2 and 1.8.3 were `main`-only bumps (docs; the hosts revert)
>   and will never be published — the gap is intentional, like 1.1.0's. This 1.9.0 reuses the
>   number d368040 briefly carried; that one never reached npm, so no conflict.
> - Tags: `v1.7.0`, `v1.7.1`, `v1.8.0`, `v1.8.1` (latest). No tag until 1.9.0 publishes.
> - npm: 1.0.0, 1.0.1, 1.2.0, 1.3.0, 1.4.0, 1.5.0, 1.6.0, 1.7.0, 1.7.1, 1.8.0, **1.8.1**. (1.1.0 is a gap.)

## Context & gotchas
> - **An Oxygen `<style>` block is NOT page-scoped, and its class prefix is not ours to pick.**
>   Every class passed to `html-to-page` becomes a global site-wide selector that outlives the
>   page. Worse, `breakdance_mcp_derive_css_prefix()` builds a recommended prefix from the site
>   name's initials and `ap` is not in its reserved list, so `ap-*` belonged to any site called
>   "Acme Plumbing" — and an import REPLACES a same-named selector's properties. Hence
>   `agentpress-verify-*`. Never shorten it back.
> - **Deleting an Oxygen selector is not reversible by re-adding the CSS.** Elements bind by
>   uuid; deleting one strips `class=""` from every page using it, and `create_id()` mints a
>   fresh uuid so a re-import leaves the page broken while appearing fixed. The only undo is
>   the builder's own revision history. `/verify` and AGENTS.md both refuse to do it.
> - **`agentpress` is NOT a command.** `package.json` ships one bin, `create-agentpress`, and
>   the decision was NOT to add an alias. Inside a site, `agentpress` is only an npm *script*
>   (`npm run agentpress`). A test now pins both the template strings and the single-bin rule.
> - **WordPress matches `.htaccess` markers with `str_contains()` per LINE.** Never put that
>   text in our block, not even in a comment. Guarded at write time plus two tests.
> - **There is a GitHub CI workflow, and CI runs WITHOUT PHP, Laragon, MySQL or WordPress.**
>   A green `npm test` here does not mean a green pipeline. Six pushes went out red during the
>   1.8.0 work. The break: a test's PHP-unavailable escape hatch watched for `not-affected`,
>   the status string v1.8.0 renamed to `unknown-libxml` — invisible on a machine with PHP.
>   Check `gh run list --repo briansmith80/agentpress --limit 1` after pushing; reproduce a
>   runner locally with `AGENTPRESS_LARAGON_ROOT` pointed at a path with no PHP.
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
