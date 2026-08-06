---
session_date: 2026-08-06T06:33:38Z
author: claude-code
operator: briansmith80
repo: briansmith80/agentpress
branch: main
base: main
status: done
handoff_reason: end-of-day
---

# Handoff: v1.4.0 + v1.5.0 shipped — agent-API containment, MCP hardening, and the first automated tests

> **Maintainer session notes — not user documentation.** If you just cloned this repo, start
> at [README.md](README.md); for how to work in it, read [CLAUDE.md](CLAUDE.md); to release,
> follow [RELEASING.md](RELEASING.md). Nothing below is needed to *use* the tool.
>
> Earlier handoffs are archived under `.handoffs/`. The previous one (2026-07-30) was badly
> stale — it predated the rename to AgentPress, the npm publish, and everything from v1.1.0
> onward. Treat anything in the archive as history, not current state.

## TL;DR
> Two releases shipped today and both are live on npm: **1.4.0** closed a remotely-exploitable
> hole (the Agent Connector abilities pack — shell-exec, PHP-eval, filesystem write — was
> reachable from any network the laptop joined), and **1.5.0** fixed the MCP wiring subsystem,
> added a `rewire` command, and introduced this project's **first automated tests + CI**.
> Everything is merged, pushed, tagged, released, and verified. Nothing is in flight.
> The most useful next action is housekeeping, not code: the two merged branches can be
> deleted, and `PLANNING/TODO.md`'s Oxygen `html-to-page` breakage is the largest known
> unfixed issue.

## Objective / Goal
> Make AgentPress safe and pleasant for people other than its author, without over-engineering
> it and without trying to fix upstream projects' code. Concretely this session: close the
> security hole found by audit, make the MCP wiring (the tool's differentiator) actually
> trustworthy, and stop the publish-fix-publish churn by making changes verifiable in seconds
> instead of via a multi-agent review. **Definition of done for this session: met.**

## Current Status
> **Live and verified on npm (`create-agentpress`): 1.5.0.** Versions published: 1.0.0, 1.0.1,
> 1.2.0, 1.3.0, 1.4.0, 1.5.0. (1.1.0 is a permanent gap — see Gotchas.)
>
> **Verified by running it, not by inspection:**
> - Full scaffold → destroy cycle run four times today; the final one against the 1.5.0
>   release candidate. Permalinks 200, `.env` not served, MCP wired *and verified*, exactly one
>   application password, teardown leaving zero residue (no dir, vhost, schema, DB user or
>   registry entry).
> - The containment fix probed from the machine's **LAN address**: all seven attack shapes
>   return 403, loopback still returns 401/400, ordinary content and other REST namespaces
>   still serve. The same site reverted to v1.3.0's protection returned 401/400 — i.e. the
>   exposure was real, not theoretical.
> - `rewire` re-points wiring onto an existing site and reports `verified, 37 tools`, leaving
>   `~/.claude.json` byte-identical apart from `mcpServers`.
> - 37 tests pass in ~10s. CI on `windows-latest` went green on its first run (38s).
>
> **Assumed, not verified:** Cursor/Codex/OpenCode wiring paths (only Claude Code is installed
> on this machine). Cursor detection is *probably* stale — see Blockers.

## What Changed This Session
> **v1.4.0 — security**
> - Closed a bypassable containment control. The v1.2.0 guard matched `REQUEST_URI ^/wp-json/mcp/`
>   only, so `?rest_route=/mcp/…` and `/index.php/wp-json/mcp/…` walked past it, and WordPress
>   core's own `wp-abilities/v1` namespace (which every ability opts into via `show_in_rest`)
>   was never covered at all. Replaced with a mu-plugin filtering `rest_pre_dispatch` on WP's
>   **resolved route** (immune to URL shape, guards both namespaces, runs at `PHP_INT_MAX`),
>   plus a widened `.htaccess` block as defence in depth. `update` now backfills both layers.
> - Nine bugs from the same audit: a CRLF `.env` yielded an EMPTY env so `destroy` silently
>   skipped the database drop; a loopback hosts entry blocked re-scaffolding a destroyed name
>   forever; the elevated hosts write used a substring check and then blamed the user's UAC;
>   `resume` silently widened the premium selection; `CREATE USER IF NOT EXISTS` kept a stale
>   password; plus four smaller ones.
>
> **v1.5.0 — MCP subsystem + tests**
> - Application passwords were **never actually revoked** (a name was passed where wp-cli wants
>   a UUID), so re-mints accumulated live admin-equivalent credentials and `destroy` revoked
>   nothing while saying it had.
> - Added `rewire`: re-points the machine-global MCP wiring at the site you run it in. The
>   documented newest-scaffold-wins trade-off previously had **no recovery path**.
> - Wiring is now verified against the live endpoint (a real MCP handshake) instead of asserted.
> - Cursor/OpenCode config writes no longer replace a user's whole config when it can't be parsed.
> - Stopped leaving `~/.claude.json.agentpress-bak` behind (a plaintext copy of the entire Claude
>   config plus the previous site's never-revoked password).
> - Added 37 tests, CI, `RELEASING.md`, and `prepublishOnly: npm test`.

## Key Decisions & Rationale
> - **The mu-plugin is the load-bearing control; `.htaccess` is defence in depth.** Established
>   empirically: Apache decodes the request **path** before `RewriteCond` runs but **not** the
>   query string, so `?rest_route=%2Fmcp%2Fx` reaches WordPress decoded. URL-text matching can
>   never be complete; testing WP's resolved route can.
> - **`update` may write into `public/` — exactly one exception.** It was "never touch public/",
>   but that would have left every pre-1.4.0 site permanently exposed with no fix short of
>   re-scaffolding. Only the guard files (ours outright) are written.
> - **Keep MCP wiring machine-global; add `rewire` instead of per-project scoping.** Per-project
>   `.mcp.json` was rejected as an architecture change for a problem a recovery command solves.
> - **Do not chase other projects' code.** Codex masks env values in `mcp get`, so its wiring
>   target genuinely cannot be read back — `doctor` now says so rather than guessing. Cursor's
>   binary name is unverified, so the detection name was left alone rather than guessed at.
> - **Batch fixes, publish once.** Adopted mid-session after the operator pointed out we were
>   publishing repeatedly. Reason each round found more: the audit sliced a *different area*
>   each time, working through one backlog — not new decay.
> - **Tests over more review.** Two adversarial reviews each found high-severity bugs in my own
>   fixes. Tests are the durable answer; a review is not repeatable.
> - **Rejected as over-engineering:** per-site PHP switching, push/pull to hosting, multisite,
>   provenance markers on MCP entries, fsync.

## Files Touched
| Path (repo-relative) | Change | Why it matters |
|------|--------|----------------|
| `src/mcp.mjs` | MODIFIED (heavily) | The whole MCP subsystem: `revokeAppPasswords` (UUID lookup), `verifyMcpEndpoint` (real handshake, settles on every terminal event), `updateJsonConfig` (safe config writes), `readWiredHostnames`. Start here for anything MCP. |
| `src/wordpress.mjs` | MODIFIED | The containment control: `MCP_GUARD_PHP` (the mu-plugin), `HTACCESS_GUARD_BLOCK`, `writeMcpLoopbackGuard`, `spliceHtaccessGuard`. Read the comments before editing — they record what was probed live. |
| `src/engine.js` | MODIFIED | `rewireCommand`, `wireMcpForSite` + `reportMcpOutcome` (shared by scaffold and rewire), `isAgentPressSiteDir` (the marker gate all three in-site commands share), pending-selection persistence. |
| `src/laragon.mjs` | MODIFIED | `hostsContentEntryAddresses` — the ONE definition of "is this hostname in hosts"; three parsers used to disagree. Plus `findVhostForHostname`, `isLoopbackAddress`. |
| `src/destroy.mjs` | MODIFIED | Uses the fixed revocation and now reports a failure to revoke in the summary + exit code. |
| `src/doctor.mjs` | MODIFIED | New "MCP target" row: which site actually owns the wiring. |
| `src/names.mjs`, `src/mysql.mjs`, `src/wildcard.mjs` | MODIFIED | Collision `kinds`, `ALTER USER`, token-exact elevated hosts script. |
| `template/scripts/agentpress.mjs` | MODIFIED | Frozen per-site menu: `wiredHostFor` (3-state), the wrong-site warning + keypress, `AGENT_COMMANDS`. **Must stay import-free** — `test/parity.test.mjs` enforces that. |
| `test/*.test.mjs`, `test/assert-tarball.mjs` | NEW | 37 tests + the published-payload assertion. |
| `.github/workflows/ci.yml` | NEW | Windows CI: syntax, tests, CLI smoke, tarball assertion. |
| `RELEASING.md` | NEW | The release order and the verify-after-publish lesson, written down at last. |
| `SECURITY.md` | MODIFIED | Discloses both defects by version, with remediation. |

## Commands & Environment to Reproduce
> Requires Windows, Laragon (Apache **not** Nginx, plus MySQL) running, and Node ≥ 18
> (developed against 22.14). No npm dependencies — nothing to `npm install`.
>
> ```bash
> git clone https://github.com/briansmith80/agentpress.git   # anywhere EXCEPT Laragon's www\
> cd agentpress
> npm test                    # 37 tests, ~10s, needs no Laragon
> node index.js doctor        # env check, must exit 0
> node index.js <name>        # scaffold
> ```
>
> Optional env vars, **names only** (see README): `AGENTPRESS_LARAGON_ROOT`,
> `AGENTPRESS_MYSQL_ROOT_PASSWORD`, `AGENTPRESS_MYSQL_PORT`, `AGENTPRESS_PREMIUM_PLUGINS_REPO`,
> `AGENTPRESS_OXYGEN_LICENSE`. Legacy `KATALYST_*` spellings still honoured. Per-site secrets
> live only in each site's gitignored `.env`; the Oxygen licence lives in `~/.agentpress/config.json`.
> Setting `AGENTPRESS_LARAGON_ROOT` in CI skips a multi-second PowerShell probe.

## How to Verify / Test
> 1. `npm test` → 37 passing. This is the fast gate and it needs no Laragon.
> 2. `node index.js doctor` → exit 0; `AGENTPRESS_LARAGON_ROOT=C:/nope node index.js doctor` → exit 1.
> 3. `node test/assert-tarball.mjs` → asserts the *published* payload shape.
> 4. **The containment fix** (needs a scaffolded site and the machine's LAN IP):
>    `curl -sk -o /dev/null -w "%{http_code}" --resolve "<site>.test:443:<LAN-IP>" https://<site>.test/wp-json/wp-abilities/v1/abilities/agent-connector-for-wp/shell-exec/run -X POST -d '{}'`
>    → **403**. The same path via `127.0.0.1` → **400/401** (reachable locally). Done = both.
> 5. Full scaffold recipe and the residue checklist: `RELEASING.md` step 2.

## Open Questions / Blockers
> - **[BLOCKER — known-broken upstream]** Oxygen's `html-to-page` MCP tool fails on *every*
>   input on 6.2.0-beta.2 (libxml ≥ 2.10 vs the builder's own `parse_fragment`). Ships from the
>   cached premium zip, so every scaffold installs it. Workaround: `edit-post` +
>   `insert-stylesheet`. Diagnosis and candidate fixes are in `PLANNING/TODO.md`. **Needs a
>   scope decision, not a patch.**
> - **[QUESTION] Cursor CLI detection is probably stale.** `src/agents.mjs` probes for
>   `cursor-agent`; an audit claims the shipped Windows binary is now `agent`. Unverified — no
>   Cursor on this machine. Deliberately not changed on a guess. Needs someone with Cursor to
>   run `Get-Command` and report.
> - **[RISK] Only Claude Code is exercised.** Cursor, Codex and OpenCode wiring is written but
>   never run end to end. Codex's teardown guard is additionally known-weak: `codex mcp get`
>   masks env values, so the ownership check can't match.
> - **[RISK] npm auth expires silently** and reports publish failures as `404 Not Found`, not
>   401. `npm whoami` before publishing. This is what made 1.1.0 vanish.
> - **[RISK] Machine-global MCP wiring.** Scaffolding a test site repoints your live wiring and
>   destroying it removes the entry. Snapshot `~/.claude.json`'s `mcpServers` before test
>   scaffolds; `rewire` restores it afterwards.

## Next Steps (ordered, actionable)
> 1. [ ] Delete the two merged branches: `git branch -d mcp-hardening security-1.4.0`
>    (both are fully merged into `main`; kept only as this session's safety net).
> 2. [ ] Decide what to do about Oxygen `html-to-page` (see `PLANNING/TODO.md`). It is the
>    largest known user-facing breakage and it is upstream, so the options are: pin an older
>    zip, patch the zip on install, or document and wait.
> 3. [ ] Confirm or fix the Cursor CLI binary name, then wire it properly (`src/agents.mjs`
>    `AGENT_COMMANDS`, and the frozen menu's copy — `test/parity.test.mjs` will fail if they drift).
> 4. [ ] Optional, from the original 62-finding audit and still unfixed: progress output during
>    the multi-minute download steps (a stuck run and a slow run look identical); an
>    `info`/`open` command for day-2 use; a `snapshot`/`rollback` pair (cheap via `wp db export`,
>    and a genuine differentiator for agent work); scaffolding a `CLAUDE.md`/`AGENTS.md` into
>    each site; `WP_DEBUG` on by default.
> 5. [ ] Lower priority: generated passwords carry ~41 bits of entropy from a 32-byte source
>    (`src/secrets.mjs` truncates); the scaffold summary prints the admin password to stdout
>    even when an agent is capturing it; `doctor` has no Windows Firewall check.

## Git State
> - Branch: `main` (pushed: yes; up to date with `origin/main`: yes)
> - Last commit at handoff time: `bbff6e8 merge: MCP hardening, a rewire command, and the first automated tests (v1.5.0)`
> - Tags: `v1.4.0` → `32ad11e`, `v1.5.0` → `bbff6e8`. GitHub releases exist for both.
> - Uncommitted: NONE (this handoff is the only change)
> - Merged-but-undeleted branches: `mcp-hardening`, `security-1.4.0`
> - To get current state: `git fetch && git switch main && git pull`

## Context & Gotchas
> - **`update` does NOT touch MCP wiring or credentials.** It looks like the obvious fix for a
>   site whose agents can't see it; it isn't. `rewire` is. This bit us live this session.
> - **npm reports a publish auth failure as `404 Not Found`.** `npm whoami` must print
>   `briansmith80`. 1.1.0 was believed published and never landed because of this.
> - **`node --test test/` does not work here**; use the glob form (`npm test` already does).
> - **`node --check` cannot see an undefined identifier.** A missing `dim` import survived every
>   local test because the branch only runs when *no* agent CLI is installed. The CLI smoke test
>   in CI exists for this class.
> - **The frozen menu (`template/scripts/agentpress.mjs`) cannot import from `src/`** — `src/`
>   doesn't exist beside a scaffolded site. It carries deliberate duplicated copies; `test/parity.test.mjs`
>   is what stops them drifting. Existing sites only get changes when `update` is run in them.
> - **Testing `verifyMcpEndpoint` needs adversarial servers, not a happy path.** Its first version
>   settled only on `res 'end'`, so a response truncated *after* headers hung forever — and with
>   nothing holding the event loop open, a scaffold could exit(0) mid-run while reporting success.
> - **`/.env` returning 403 instead of 404 is fine on this machine** — Apache denies dotfiles
>   globally; an unrelated non-AgentPress site does the same. What matters is "not 200".
> - **Do not spawn a competing Apache.** Tried and reverted long ago: it restores the port with a
>   *stale config*, serving every existing site while silently 404ing the new one.
> - **Windows `spawn` cannot launch `.cmd`/`.ps1` shims with `shell:false`** (`claude`, `codex`,
>   `gh`, `wp.bat`). Route through `psRun`/`psCapture`. This shipped silently twice.
> - **`spawnCapture`/`psCapture` never throw — always check `.code`.** Assumed success is the root
>   cause of the worst silent failures in this project's history, including the app-password one
>   fixed today.
> - **Secrets**: no generated password, application password, licence key or admin-login token
>   from this session appears in this file or in git. Admin login links are single-use, ~300s TTL.
