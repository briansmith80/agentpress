---
session_date: 2026-07-30T16:53:29Z
author: claude-code
operator: brian.smith@cognitomedia.com
repo: briansmith80/katalyst-laragon
branch: main
base: main
status: in-progress
handoff_reason: switching-machines
---

# Handoff — `create-katalyst-laragon`: Laragon-native port of soflyy/katalystwp

## TL;DR
> A full, working port of [soflyy/katalystwp](https://github.com/soflyy/katalystwp) (a
> Docker-based WordPress+AI-agent scaffolder) to run natively on Laragon (Windows, no
> Docker) is built, live-tested end-to-end on this machine, and pushed to a **private**
> GitHub repo. It works for scaffolding real sites on *this* machine right now. The single
> most important next action: **decide what "packagable for other users" means** (npm
> publish? support Nginx? just validate on a second machine first?) — that question was
> open, unanswered, when this session ended. See "Open Questions" below.

## Objective / Goal
> Port katalystwp's developer experience — one command scaffolds a local WordPress site
> with a dedicated database, the AI-agent MCP wiring, and a one-click admin login — from
> Docker Compose onto Laragon (native Windows: Apache + MySQL + PHP + Node, no containers).
> Originally scoped as "full feature parity": multi-agent support, MCP, a site registry
> with list/update, teardown. Definition of done for *that* scope has been met. What's
> **not** done: making it usable by someone other than the person who built it, on a
> machine other than this one — that's the open, larger goal stated at the end of this
> session ("I want this to be able for other users to use as well").

## Current Status
> **Works, verified live on this machine, right now:**
> - `node index.js <name>` — full scaffold: hostname + vhost, dedicated MySQL DB/user,
>   WordPress core + config + permalinks, plugins, the Agent Connector MCP gateway plugin,
>   MCP wiring for any detected AI agent CLI (Claude Code confirmed working — asked Claude
>   to use the wired MCP tool and got real site data back), a one-click admin login link,
>   and registration in a local site registry.
> - `node index.js resume <name>` — added *after* a real (non-test) run hit the known
>   Apache-staleness failure (see Context & Gotchas) and needed manual completion. Picks up
>   from an existing, reachable vhost and runs the rest of the pipeline. Verified live on
>   the user's actual first real site (`oxygen-mcp-auto-install`).
> - `doctor`, `list`, `update`, `destroy`, `register-quick-app` — all implemented and
>   live-verified (see Files Touched for what each does).
>
> **Explicitly NOT done — known gaps, not oversights:**
> - `--setup-script=` / `--dev-script=` customization hooks from the original: not ported.
> - Agent CLIs are detected, never auto-installed (`npm i -g`) if missing.
> - **Only ever tested on this one machine.** Two of the real bugs found during the build
>   turned out to be general Windows/Apache issues (see Gotchas), which is a good sign —
>   but there's no evidence a third, machine-specific issue isn't waiting on a different
>   Laragon install.
> - `LARAGON_ROOT` is **hardcoded** to `C:\laragon` (Laragon's default install path — not
>   detected).
> - **Apache-only.** PHP resolution, the vhost lookup, and the Application-Passwords
>   Authorization-header fix all assume Apache. Laragon also supports Nginx; nothing
>   detects that or fails gracefully — it would just break confusingly.
> - Not published to npm. `npm create katalyst-laragon` does not work; only
>   `node index.js <name>` from a clone does.
> - The repo is **private**. User explicitly chose private-for-now specifically because of
>   the gaps above — flip to public once they're closed and it's been tried on a second
>   machine.

## What Changed This Session
> Built from an empty directory to the current state in one long session (research → plan
> → 9 build phases, live-tested throughout → GitHub push → one post-launch bugfix pass).
> - Researched both sides before building: the original `soflyy/katalystwp` repo's
>   architecture (engine.js/ui.js/templates), and this machine's actual Laragon install
>   (PHP/MySQL/Apache versions, vhost mechanism, SSL, hosts file, existing ~87 sites).
> - Wrote and validated a phased build plan (see Reference Links) — a Plan-mode stress-test
>   pass surfaced most of the real risks *before* coding (docroot-detection races, Windows
>   `.bat`/shell quoting, Apache reload reliability, MySQL auth-plugin mismatches).
> - Implemented all 9 planned phases: doctor/env-check → hostname+vhost provisioning →
>   per-site MySQL DB/user → WordPress install → templates/registry/menu → plugins + Agent
>   Connector → MCP wiring + one-click login → dev/teardown/docs.
> - Found and fixed 5 real bugs via live testing (not code review) — see Context & Gotchas.
> - Added a `resume` command after a real (non-test) run hit exactly the failure mode the
>   design had flagged as a known limitation — turned a documented gap into a shipped fix.
> - Initialized git, added a GPL-2.0-or-later `LICENSE` (fetched verbatim from GitHub's
>   license API to guarantee exact text, matching the original project's license), committed
>   everything, and pushed to a new **private** GitHub repo.

## Key Decisions & Rationale
> - **Native Windows, no Docker/WSL** — chosen over containerizing to match how Laragon
>   users actually work. Rejected WSL2 isolation as unnecessary complexity for this goal.
> - **`public/` as the WordPress docroot** — Laragon auto-detects a nested `public/` as the
>   Apache document root (verified against 40+ existing projects on this machine before
>   building anything), so this gets vhost creation "for free" and keeps `.env` outside the
>   web root. Verified live: wrong docroot → `.env` served as plaintext over HTTP (200);
>   correct docroot → 404. This is why the probe-token verification step exists at all.
> - **Stage-in-temp-dir, then atomic rename into `www\`** — required, not optional.
>   Confirmed live: Laragon **never re-derives** the vhost docroot once a conf exists for a
>   folder, even if you add `public/` to it afterward and reload twice. The tree must be
>   complete *before* Laragon ever sees the folder.
> - **Detect-and-report only for Apache — never self-relaunch it.** Tried spawning a fresh
>   `httpd.exe` when Apache was found down, confirmed live it brought the TCP port back with
>   a **stale in-memory config** (served every pre-existing site fine, silently 404'd the
>   brand-new one) — worse than a clear failure, because it looks like "the site doesn't
>   exist" instead of "Apache needs a restart". Reverted. Current design just detects, waits
>   patiently within a budget, and tells the user to do a full Stop All → Start All if it's
>   still down — a real, accepted limitation, not an oversight.
> - **Per-site dedicated MySQL DB + user, never reuse root** — root credential is discovered
>   (empty password, then `"root"`, then the `KATALYST_MYSQL_ROOT_PASSWORD` env var) but
>   never written into any scaffolded site.
> - **Playwright MCP over stdio, not a container** — no networking/isolation concern to
>   solve on native Windows, so the original's HTTP-server-in-a-container design collapses
>   to just spawning `npx @playwright/mcp` when an agent connects.
> - **Agent Connector plugin always installed**, regardless of what other plugins the user
>   picks — it's the MCP gateway, matches the original's own behavior.
> - **Private GitHub repo, not public, not npm-published yet** — explicit user choice,
>   specifically *because* of the untested-portability gaps above. Revisit once those close.

## Files Touched
| Path (repo-relative) | Change | Why it matters |
|------|--------|----------------|
| `index.js` | NEW | bin entrypoint, dispatches to `src/engine.js` |
| `src/engine.js` | NEW | CLI dispatch + all command flows (scaffold/resume/update/destroy); `finishInstall()` is the shared DB→WordPress→plugins→MCP→registry pipeline used by both scaffold and resume |
| `src/laragon.mjs` | NEW | reload+poll, vhost reverse-lookup by `ROOT`, verify-and-repair, hosts snapshot — read the file header comment, it documents 5 live-confirmed Apache-reload failure modes |
| `src/wp.mjs` | NEW | the `spawn(php.exe, …, {shell:false})` primitive every `wp` call goes through — never spawns `wp.bat` directly (Node refuses `.bat`/`.cmd` with `shell:false`) |
| `src/mysql.mjs` | NEW | root credential discovery ladder, per-site DB/user provisioning, collision-safe naming |
| `src/wordpress.mjs` | NEW | WordPress core download/extract (bypasses a broken `wp core download` on this Windows+WP-version combo), `wp-config.php`, permalinks, the hand-written `.htaccess` (rewrite rules + the Authorization-header fix) |
| `src/plugins.mjs` | NEW | plugin install/activate, the Agent Connector + universal-abilities-plugin pair with an `is-active` idempotency guard |
| `src/junctions.mjs` | NEW | sibling-checkout → `wp-content` workflow via directory junctions; junction-safe recursive delete (unlinks junctions before recursing, so a delete can't follow a link into a real checkout) |
| `src/mcp.mjs` / `src/admin-login.mjs` | NEW | per-agent MCP server config (Claude/Cursor/Codex/OpenCode), the one-click login link mint |
| `src/registry.mjs` / `src/templates.mjs` | NEW | the local sites registry (`~/.katalyst-laragon/environments.json`), the scaffold-time template-copy engine |
| `src/destroy.mjs` / `src/quickapp.mjs` | NEW | full teardown (DB, MCP entries, app password, vhost, folder — in that order, see file header), Laragon Quick-app `sites.conf` registration |
| `src/names.mjs`, `src/agents.mjs`, `src/secrets.mjs`, `src/paths.mjs`, `src/win.mjs`, `src/fsutil.mjs`, `src/doctor.mjs` | NEW | name validation/collision checks, agent-CLI detection, password generation, path constants, small Windows process helpers, the `doctor` env-check command |
| `template/` (whole dir) | NEW | the payload copied into every scaffolded site — `template/scripts/katalyst.mjs` is the frozen, dependency-free per-site menu; it duplicates a few small pieces from `src/` on purpose (documented in the file header) |
| `README.md` | NEW | architecture table + an explicit "Known limitations" section — start here in a fresh session |
| `LICENSE` | NEW | GPL-2.0-or-later, verbatim from GitHub's license API |

## Commands & Environment to Reproduce
> Requires: Windows, Laragon installed **at `C:\laragon`** (hardcoded — see gaps above),
> with **Apache** (not Nginx) as the active web server, MySQL, and Node ≥ 18 (developed and
> tested against Node 22.22.0). Laragon must be running (Apache + MySQL started) before any
> scaffold command.
>
> ```bash
> cd C:\laragon\www\katalyst-laragon
> node index.js doctor              # env sanity check — run this first, always
> node index.js <name>               # scaffold a new site at http://<name>.test
> node index.js resume <name>        # finish a scaffold that got through vhost creation but not further
> node index.js list                 # list scaffolded sites
> node index.js update               # refresh a site's Katalyst-owned files (run from inside that site's dir)
> node index.js destroy              # permanently remove a site (run from inside that site's dir)
> node index.js register-quick-app   # add a Laragon Quick-app tray entry
> ```
> Optional env var (by name only): `KATALYST_MYSQL_ROOT_PASSWORD` — set this if MySQL root
> has a non-empty, non-`"root"` password on the target machine; the tool's discovery ladder
> tries empty and `"root"` before giving up and asking for this.
>
> No npm dependencies (`package.json` has none) — nothing to `npm install`.

## How to Verify / Test
> There is no automated test suite — everything was verified by actually running it against
> the real Laragon install. To confirm a clean environment still works end to end:
> 1. `node index.js doctor` — should report Laragon/Apache/MySQL up, PHP resolved, WP-CLI
>    installed (auto-installs to `C:\laragon\usr\bin` on first run if missing).
> 2. `node index.js ktest1` — scaffold a throwaway site. **Expect a brief machine-wide
>    Apache/MySQL blip** (the tool warns about this) and possibly a Windows permission
>    popup for the hosts-file write.
> 3. Once it prints the summary card: `curl http://ktest1.test/hello-world/` should return
>    200 (proves permalinks + the hand-written `.htaccess` actually work — this is the exact
>    check that caught two of the bugs below).
> 4. `curl http://ktest1.test/.env` should be 404 (proves the docroot is correct — `.env`
>    lives outside `public/`).
> 5. If an agent CLI (e.g. Claude Code) is on PATH: `claude mcp list` from inside the
>    project dir should show `wordpress` and `playwright` as Connected.
> 6. `node index.js destroy --yes` (run from inside `ktest1`'s directory) should leave zero
>    trace in `sites-enabled`, `SHOW DATABASES`, and `claude mcp list` — only a dangling
>    hosts-file line is expected to remain (documented, intentional).

## Open Questions / Blockers
> - **[QUESTION]** What does "packagable for other users" actually mean to the user? This
>   was asked at the very end of the session and never answered. The candidate next steps,
>   roughly ordered by effort: (a) just validate on a second machine (e.g. the home machine
>   this handoff is for) — cheapest, highest information value; (b) detect `LARAGON_ROOT`
>   instead of hardcoding it; (c) detect Nginx vs Apache and at minimum fail clearly instead
>   of confusingly; (d) publish to npm so `npm create katalyst-laragon` works for anyone.
>   Don't assume an order — ask, or use (a) as the natural first move since this handoff's
>   own purpose is "try it on a second machine."
> - **[RISK]** Laragon's `reload` unreliability (see Gotchas) is a property of Laragon
>   itself, observed repeatedly on this one machine. Whether it's equally flaky on the home
>   machine is unknown — could make the first scaffold there confusing if this context isn't
>   read first.
> - **[RISK]** MySQL root credential on the home machine's Laragon install is unverified —
>   if it's neither empty nor `"root"`, the first scaffold attempt there will fail clearly
>   (with instructions to set `KATALYST_MYSQL_ROOT_PASSWORD`), not silently.

## Next Steps (ordered, actionable)
> 1. [ ] On the home machine: `git clone https://github.com/briansmith80/katalyst-laragon.git`
>    into `C:\laragon\www\`, confirm Laragon is installed at the default `C:\laragon` path
>    and running Apache (not Nginx), then run `node index.js doctor`.
> 2. [ ] Scaffold one real throwaway site there end-to-end as a second-machine validation —
>    this directly answers whether the portability gaps in "Current Status" actually matter
>    in practice, or whether this machine's defaults are common enough that it Just Works.
> 3. [ ] Report back what broke, if anything — that's the real input needed to prioritize
>    the open question above rather than guessing at it.
> 4. [ ] Once there's real signal from step 2-3, pick from: generalize `LARAGON_ROOT`
>    detection, add Nginx detection/support, or set up npm publish — probably in that order
>    of effort, but let the second-machine results decide.

## Git State
> - Branch: `main` (pushed: yes, up to date with `origin/main`: yes)
> - Last commit: `0a100d9 Initial commit: create-katalyst-laragon` (the only commit — full
>   history of *how* this was built lives in this chat session and the local plan file, not
>   in git history)
> - Uncommitted: NONE
> - To get current state: `git clone https://github.com/briansmith80/katalyst-laragon.git`
>   (fresh clone — nothing to fetch/pull yet, this is the only commit)

## Context & Gotchas
> - **`laragon.exe reload` is not fully reliable once Apache has been running a while.**
>   Confirmed live, repeatedly (5+ times in one session): can leave Apache serving a stale
>   in-memory config (site 404s despite a correct on-disk vhost conf) or crash it outright.
>   Fix that works: a full Stop All → Start All in Laragon (not just Reload) forces a
>   genuinely fresh process. The code detects this and tells the user to do that — it does
>   **not** try to fix it automatically (see Key Decisions for why self-relaunch is worse).
> - **`wp core download`'s extraction is broken on Windows for the WordPress version this
>   pulled (7.0.2)** — PHP's `PharData::extractTo()` fails on a core file path that lands
>   just past the classic 100-character USTAR filename-field boundary (a known PHP/Windows
>   `PharData` bug), and WP-CLI's own `tar` fallback also failed (couldn't locate `tar.exe`
>   despite it being on PATH). Fixed in `wordpress.mjs` by bypassing WP-CLI's downloader
>   entirely — fetch the tarball directly, extract with a directly-resolved `tar.exe`.
> - **`wp rewrite flush --hard` does not write `.htaccess` when run from a CLI context —
>   true in general, not a Laragon-specific quirk.** WP-CLI never runs inside an actual
>   Apache request, so WordPress's `got_mod_rewrite()` can't detect Apache and silently
>   refuses to write the file (prints a warning, doesn't fail). `wordpress.mjs` writes the
>   standard WordPress ruleset by hand right after the flush call.
> - **Application Passwords failed outright with a bare 401 until fixed** — Apache's
>   `mod_fcgid` (a CGI/FastCGI PHP SAPI) strips the `Authorization` header before PHP ever
>   sees it. This is a well-known issue for **any** CGI/FastCGI PHP SAPI, not specific to
>   Laragon. Fixed with the standard `RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]`
>   re-exposure rule, now baked into the `.htaccess` `wordpress.mjs` writes.
> - **`wp eval-file` needs an actual `<?php` opening tag; `wp eval` (what the original
>   Docker project used) does not.** The admin-login PHP payload was ported from the
>   original without the tag, so it printed itself as literal text instead of executing.
>   Fixed in `wp.mjs`'s `runWpEvalFile()` — auto-prepends `<?php\n` when missing — plus the
>   necessarily-duplicated copy inside the frozen `template/scripts/katalyst.mjs`.
> - **`destroy` crashed with `EBUSY`** the first time it was run the way its own on-screen
>   instructions say to run it — `cd` into the site directory, then run the command — because
>   Windows won't `rmdir` a directory that's a live process's cwd. Fixed in `destroy.mjs` by
>   detecting that case and `chdir`-ing to `WWW_DIR` before the recursive removal.
> - **The `resume` command's first real bug: `fileExists()` used `readFile`, which throws
>   `EISDIR` on a directory** — so it reported an existing, correct project folder as
>   "nothing to resume." Fixed by switching to `stat`. Caught by actually running the new
>   command against a real site, not by review — a good reminder that every "shipped" piece
>   in this codebase has only really been proven by live use, not inspection.
> - **Admin-login links and application passwords are one-time/short-lived (≈5 min TTL) —
>   never paste a previously-minted one into anything.** Always re-mint fresh (the `katalyst`
>   menu's "Open WP Admin" does this automatically).
> - Every generated secret this session (WP admin passwords, DB passwords, application
>   passwords, one-time login tokens) was deliberately **excluded** from this handoff and
>   from git — they're per-site, regenerated on every scaffold, and live only in each site's
>   own gitignored `.env`.

## Reference Links
> - Repo: https://github.com/briansmith80/katalyst-laragon
> - Ported from: https://github.com/soflyy/katalystwp
> - Detailed build plan + full phase-by-phase live-test findings (on the **original**
>   machine only, not yet copied into this repo):
>   `C:\Users\brian\.claude\plans\validated-exploring-dahl.md`. This is significantly more
>   detailed than this handoff (e.g. exact Laragon vhost-template contents, byte-level
>   quoting analysis, the full Phase 0 calibration experiments) — worth copying into the
>   repo (e.g. as `docs/design-notes.md`) as a first task if deeper history is ever needed
>   from a machine that isn't the original one.
