---
session_date: 2026-07-30T16:53:29Z
author: claude-code
repo: briansmith80/katalyst-laragon
branch: main
base: main
status: in-progress
handoff_reason: switching-machines
---

> **PUBLISHED: create-agentpress@1.0.0 is live on npm (2026-08-02); the old
> create-katalyst-laragon package is deprecated with a pointer.**
>
> **RENAMED 2026-08-02: this project is now AgentPress** (npm: create-agentpress,
> repo: briansmith80/agentpress, config: ~/.agentpress with auto-migration, env vars
> AGENTPRESS_* with legacy KATALYST_* honored). Historical references below to
> katalyst-laragon are left as written.
>
> **Maintainer session notes — not user documentation.** If you just cloned this repo,
> start at [README.md](README.md); nothing below is needed to use the tool.

# Handoff — `create-katalyst-laragon`: Laragon-native port of soflyy/katalystwp

## TL;DR
> A full, working port of [soflyy/katalystwp](https://github.com/soflyy/katalystwp) (a
> Docker-based WordPress+AI-agent scaffolder) to run natively on Laragon (Windows, no
> Docker) is built, live-tested end-to-end on this machine, and pushed to a **private**
> GitHub repo. **Update: second-machine validation (the home machine) is now done.** Env
> defaults (Laragon at `C:\laragon`, Apache active, MySQL root creds) all matched with zero
> changes needed; the known Apache-reload-staleness failure hit on the very first real run
> and `resume` recovered it correctly, exactly as designed. One real portability bug *was*
> found — MCP wiring for Claude/Codex silently failed on this machine (see Context &
> Gotchas) — and it's now fixed and verified live. Current focus has shifted to **making the
> tool easier to use** (see Next Steps) now that portability has real (good) signal behind
> it, rather than the earlier open question of npm-publish vs. Nginx support vs. further
> validation.

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
> - ~~Only ever tested on this one machine~~ — **now tested on a second machine (home),
>   2026-07-30.** Node v22.14.0, Apache (not Nginx) running, MySQL root creds all matched
>   the tool's default assumptions with zero configuration changes. First scaffold hit the
>   documented Apache-reload-staleness failure (expected — see Gotchas); `resume <name>`
>   picked it up and completed correctly. One real bug surfaced: MCP wiring for Claude/Codex
>   silently no-opped (see Gotchas — now fixed, commit `bdca857`). No `LARAGON_ROOT` or
>   Nginx-related failures surfaced this time, though that only means this second machine
>   happened to share the same defaults, not that those gaps are closed.
> - ~~`LARAGON_ROOT` is hardcoded~~ — **RESOLVED 2026-08-01 (v0.2.0)**: auto-detected via
>   env var → default path → the running laragon.exe's own directory (`paths.mjs`).
> - ~~Apache-only with no detection~~ — **partially RESOLVED 2026-08-01**: still
>   Apache-only, but Nginx mode and foreign :80 owners (IIS) are now detected and refused
>   with clear instructions in preflight and doctor, instead of failing confusingly.
> - Not published to npm (deliberate — distribution decision made 2026-08-01: private repo
>   + friend as read collaborator, `git pull` as the update channel; all `npx` references
>   removed from code/docs until a real publish happens). `node index.js <name>` from a
>   clone is the interface.
> - The repo is **private**. Decision 2026-08-01: stays private for v0.2.0; friend gets a
>   collaborator invite (owner action, needs their GitHub username).

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
> - **[RESOLVED]** ~~What does "packagable for other users" mean?~~ Second-machine
>   validation (2026-07-30) gave real signal: env defaults matched with zero config changes,
>   `resume` worked correctly under a real (not staged) Apache-reload failure, and only one
>   actual bug surfaced (MCP wiring — now fixed). That's a good sign the untested-portability
>   risk was smaller than feared. Still open: whether a *third* machine with a non-default
>   Laragon path or Nginx would surface the gaps that didn't trigger here — not yet closed,
>   just not yet hit.
> - **[NEW FOCUS]** Now shifting to **ease-of-use** rather than further portability
>   validation — see Next Steps.
> - **[RISK, still open]** Laragon's `reload` unreliability (see Gotchas) is a property of
>   Laragon itself — confirmed to reproduce on a second machine too (this is what caused the
>   first ktest1 scaffold attempt to fail, before `resume` recovered it). Not fixable from
>   this side; already handled by detect-and-report + `resume`.
> - **[RISK, closed]** ~~MySQL root credential on the home machine's Laragon install is
>   unverified~~ — confirmed empty/`"root"` discovery ladder worked with no
>   `KATALYST_MYSQL_ROOT_PASSWORD` override needed.

## Next Steps (ordered, actionable)
> 1. [x] Second-machine validation — done 2026-07-30. See Current Status / Open Questions.
> 2. [x] MCP wiring bug found and fixed — `claude`/`codex` are npm `.cmd` shims on Windows;
>    `spawn(shell:false)` silently failed (`ENOENT`) launching them, and the failure was
>    swallowed rather than surfaced. Fixed by routing through `psCapture` (PowerShell) in
>    `src/mcp.mjs`, commit `bdca857`. Verified live: `claude mcp list` now shows `wordpress`
>    and `playwright` as Connected against a real scaffolded site.
> 3. [x] **Premium plugin auto-install (Oxygen/Breakdance)** — user asked for Oxygen,
>    Breakdance Elements for Oxygen, and Breakdance Forms for Oxygen to auto-install on every
>    scaffold. These are commercial, no wordpress.org/public-URL source. Built: a new private
>    repo `briansmith80/oxygen-premium-plugins` (one release tag per plugin, licensed zip as
>    the asset) that `syncPremiumPluginsFromGitHub()` pulls via `gh release download` into
>    `~/.katalyst-laragon/premium-plugins/` on every scaffold, then `installPremiumPlugins()`
>    installs+activates whichever zips are cached (matched by filename prefix, newest by
>    mtime if more than one). Both steps are best-effort/non-fatal — no `gh`/network falls
>    back to the local cache, no matching zip just skips that plugin. Repo overridable via
>    `KATALYST_PREMIUM_PLUGINS_REPO`. Verified live against `ktest1`: all three show `active`
>    in `wp plugin list`, and the sync path was specifically re-tested against an emptied
>    local cache to prove the fresh-machine case. Commit `429febd`. **Not yet done:** license
>    activation — installing ≠ licensing, Oxygen still shows `update: version higher than
>    expected` until a license key is entered by hand in `wp-admin`; unknown whether
>    Oxygen/Breakdance support a headless/define()-based license for automating that too.
> 4. [x] **Full fresh-scaffold validation** — `node index.js katalysttest2 --yes` end-to-end
>    through the real CLI (not direct function calls). Hit the real Apache-reload-staleness
>    failure again (reproducible, not a one-off); `resume` recovered it correctly. Confirmed
>    together in one real run: permalinks (200), `.env` blocked (404), all 3 premium plugins
>    active, MCP wordpress/playwright Connected and correctly re-pointed at the new site.
>    **Finding, not a bug:** MCP wiring is `--scope user` (global) — scaffolding a second site
>    silently overwrote `ktest1`'s wordpress MCP connection. Only one site's MCP connection
>    can be live at a time, machine-wide. Worth revisiting if multi-site concurrent MCP use
>    ever matters (would mean per-project `--scope local`/`.mcp.json` instead).
> 5. [x] **Ease-of-use pass, round 1: silent-failure audit.** Prompted by the MCP bug's root
>    cause (spawnCapture never checked, callers assumed success) — audited every
>    spawnCapture/psCapture call site in the codebase. Found two more real bugs, both in
>    `destroy.mjs`, both now fixed (commit `f397835`):
>    - `removeMcpEntries()` had the *exact same* `spawn('claude'/'codex', …)` shim bug as the
>      original MCP issue, just never patched when `mcp.mjs` was fixed — `destroy` reported
>      MCP entries removed without the removal call ever actually running. Fixed by
>      extracting the PowerShell-invocation logic into a shared `psRun()` in `win.mjs` (used
>      by both `mcp.mjs` and `destroy.mjs` now) instead of duplicating or missing the fix.
>    - `dbDropped` was set unconditionally after `dropDatabase()` regardless of its exit code.
>    Everything else (`wordpress.mjs`, `mysql.mjs`, `laragon.mjs`, `doctor.mjs`,
>    `admin-login.mjs`, and the no-spawn modules) already checks exit codes correctly or is
>    read-only/informational where a wrong read isn't dangerous — nothing else found.
> 6. [x] **Friend-readiness overhaul — done 2026-08-01, v0.2.0 (9 commits, `7d6198d`..
>    `5831e1f`).** Driven by a 13-agent audit (59 findings, blockers adversarially verified)
>    then a 10-agent review of the fix batch (6 confirmed findings, all fixed). Shipped:
>    LARAGON_ROOT auto-detection; Nginx/IIS-on-:80 detection with clear refusals;
>    ExecutionPolicy Bypass (stock-Windows .ps1 shims); EXDEV staging fallback;
>    `wp config create --force` (unblocked a real resume dead-end); post-.env resume via a
>    finishInstall/finishExtras split with sandbox.config.json as the completion marker;
>    stale-lock self-heal (dead-pid-only steal) + SIGINT cleanup; scaffold confirmation
>    prompt + did-you-mean for typo'd commands; exit codes on all failure paths; doctor
>    rewrite with "Ready to scaffold: YES/NO"; every failure message names the exact
>    recovery command; MariaDB naming + KATALYST_MYSQL_PORT (threaded into destroy via
>    .env's DB_HOST); premium sync hardening (atomic downloads, slug verification, config
>    file for the repo override); pinned MCP-proxy/agent-connector versions; cross-site MCP
>    removal guard in destroy; absolute wp.bat path in scaffolded sites; all `npx`
>    references replaced with clone-based commands; README rewritten for a stranger
>    (getting-started, bring-your-own premium plugins, uninstall checklist).
>    **E2E-validated live:** katalysttest3 scaffolded through the real reload-staleness
>    failure → resume → all checks green (permalinks, .env 404, 3 premium plugins active,
>    pinned MCP Connected, absolute-path `npm run wp` working).
> 7. [x] **Instant mode + npm publish — done 2026-08-01, v0.3.0.** The two structural pain
>    points are gone:
>    - **Zero-reload scaffolds:** new `setup` command installs one wildcard vhost
>      (`zzz-katalyst-wildcard.conf`, mod_vhost_alias, VirtualDocumentRoot to
>      `www/<name>/public`, `zzz-` so exact confs win under Apache's first-match order).
>      After ONE Apache restart ever, scaffolds skip the whole reload/poll/verify pipeline;
>      the tool writes the hosts entry itself via one elevated PS call (declined UAC
>      degrades to printed instructions, scaffold still completes); all probes run over
>      loopback with a Host header (DNS-free). Validated live: `instanttest1` scaffolded
>      start-to-finish in one command, permalinks/.htaccess working under the wildcard's
>      `<Directory "www/*/public">` grant, all plugins + MCP green. The reload-staleness
>      failure (3-for-3 before) is architecturally gone. Also fixed: TCP preflight probes
>      retry before declaring a port closed (two live false "Apache not listening" bails).
>    - **Published to npm:** `create-katalyst-laragon@0.3.0`, public registry, account
>      `briansmith80` (2FA passkey; publishes need a real terminal for the browser
>      confirmation — non-TTY shells get EOTP with no web fallback, learned the hard way).
>      Friend install is now: `npx create-katalyst-laragon@latest doctor` → `setup` →
>      `<name>`. No git, no clone, no collaborator invite needed for the tool. CLI prints
>      npx-form advice when running from a package (verified via clean `npx -y ...@0.3.0`
>      run); site menu's update check re-enabled; Quick-app registers the npx form when
>      package-installed.
> 8. [x] **v0.4.0 published 2026-08-01: license auto-activation + setup wizard.** Oxygen 6
>    ships `wp oxygen license <key>` (one key covers both Breakdance-for-Oxygen extensions
>    — they have no licensing code of their own); scaffolds apply the key from
>    `~/.katalyst-laragon/config.json` `licenses.oxygen` right after the premium install,
>    best-effort. Verified live: "Oxygen license active (Valid, Active)", `wp oxygen
>    status` → Pro Mode. The owner's key was extracted from doncour-oxygen-mcp's DB into
>    local config (never displayed/committed). `setup` now runs a TTY-only preferences
>    wizard: which premium plugins to auto-install (saved as `premiumPlugins`, absent=all,
>    []=none — sync+install respect it) + the license key (Enter keeps saved answers).
>    Config access centralized in `src/config.mjs`. All five session test sites destroyed
>    (the destroy MCP-guard proved itself: deleting older sites left the newest site's
>    wiring intact).
> 9. [x] **v0.5.0–v0.6.1 (published 2026-08-01):** Breakdance WooCommerce for Oxygen added
>    to the premium set (release in the private zips repo; auto-installs WooCommerce from
>    wordpress.org via `requires`); `wp plugin update --all` runs after license activation
>    on every scaffold (vendor channel pulls current Oxygen-family builds — the Woo shim
>    zip ships old on purpose and relies on this); the oxygen zip was REBUILT with two
>    fixes to `plugin/mcp/design/html-to-page.php` (empty container tags → Containers not
>    empty Text, verified by running the converter live; plus the libxml-Windows retry the
>    zip was missing vs the dev sites — both dev sites and the user's test site patched in
>    place). UX redesign: `setup` is now an availability ASSISTANT (zip status table, opens
>    the drop folder, re-scans, license key) — plugin SELECTION is per-project at scaffold
>    time (interactive picker, `--premium=all|none|slugs`, `--yes` = all available,
>    extensions auto-include Oxygen); the machine-wide `premiumPlugins` config key is
>    retired. doctor/setup end with next-step guidance. npm `latest` = 0.6.1, verified via
>    clean npx run.
> 10. [ ] **Remaining, deliberately deferred:** GitHub repo visibility (code is public on
>    npm anyway — a public repo would let the friend file issues; owner's call);
>    single-global-MCP limitation (documented in README); low-severity review leftovers
>    (Quick-app command-word names shadow scaffolding). Friend rollout is DONE:
>    `npx create-katalyst-laragon@latest doctor` → `setup` → `<name>`.

## Git State
> - Branch: `main`, pushed to `origin/main` 2026-08-01 (work machine: `git pull` to catch
>   up — do NOT re-clone, just pull).
> - Last commit at push time: `5831e1f fix(review): lock-steal races, destroy DB-port
>   targeting, quoting, doc contradictions`. Version: 0.2.0.
> - Uncommitted: NONE as of this edit
> - **External dependency:** a second, private repo `briansmith80/oxygen-premium-plugins`
>   (releases only, no code) holds the licensed Oxygen/Breakdance zips this tool pulls
>   from. Keep it private — commercial plugin zips. Overridable per-user via
>   KATALYST_PREMIUM_PLUGINS_REPO or ~/.katalyst-laragon/config.json.

## Context & Gotchas
> - **NEW (2026-08-01): orphaned-httpd failure mode identified.** If Laragon itself
>   restarts while Apache keeps running, the httpd processes are orphaned — Laragon's
>   Stop All no longer reaches them, and Start All's fresh Apache silently dies because
>   the orphans still own :80/:443. Symptoms: restarts that "don't take" (httpd StartTime
>   never changes), and possibly some of the reload-staleness incidents. Diagnosis:
>   `Get-Process httpd | Select Id, StartTime` before/after a restart. Remedy:
>   `Stop-Process` the orphans, then Start All. Candidate future doctor check.
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

> - **MCP wiring for Claude/Codex silently no-opped — found on the second machine,
>   2026-07-30.** `configureClaude`/`configureCodex` in `mcp.mjs` called
>   `spawn('claude', […], {shell:false})` directly. On Windows, `claude`/`codex` resolve via
>   PATH to npm-global `.cmd` shims, not `.exe` — confirmed live: bare `spawn('claude', …)`
>   fails with `Error: spawn claude ENOENT` (same class of issue already solved for `wp.bat`
>   elsewhere in this codebase, just not applied here). Worse, `spawnCapture` never checked
>   the exit code, so `sandbox.config.json` recorded `"agents": ["claude"]` even though
>   nothing was actually registered — the failure was completely silent. Fixed by routing
>   through `psCapture` (real `powershell.exe`, already used in `agents.mjs` for the same
>   underlying problem) with each arg single-quoted, and by throwing on a non-zero `add`
>   exit code. Verified live against a real site (not a unit test): `claude mcp list` went
>   from showing nothing to showing `wordpress`/`playwright` as Connected. Commit `bdca857`.

## Ease-of-Use Ideas (in progress this session)
> Started after MCP fix + second-machine validation — the tool is *correct* but has real
> friction for anyone other than the person who built it. Candidates being worked through,
> roughly in order of impact:
> - Silent-failure hardening elsewhere: `spawnCapture`'s pattern of "never throws, caller
>   must check `.code`" is exactly what caused the MCP bug — audit other call sites in
>   `plugins.mjs`/`wordpress.mjs`/`mysql.mjs` for the same "assumed success" gap.
> - Friendlier `doctor` output — it should be the single place a confused user looks first;
>   make sure it explains *what to do* for every failure mode, not just what's wrong.
> - Reduce first-run ceremony: hosts-file permission popup, MySQL root credential ladder,
>   WP-CLI auto-install — bundle these into one clear "first run" explanation instead of
>   surprising the user mid-scaffold.
> - `--yes`/non-interactive defaults and clearer progress output during the multi-minute
>   scaffold (it currently just prints a progress line — a stuck vs. slow run looks the same).
> - Consider whether `resume` should be auto-suggested (detected + prompted) instead of the
>   user needing to know the command exists after a failure.

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
