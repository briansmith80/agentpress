# CLAUDE.md — working on AgentPress

Guidance for Claude Code working in this repo. **Not user documentation** — that's
[README.md](README.md). Session-by-session narrative lives in [HANDOFF.md](HANDOFF.md);
in-flight plans live in `PLANNING/`.

`create-agentpress` scaffolds AI-agent-ready WordPress sites on Laragon (Windows, native
Apache/MySQL/PHP, no Docker). `index.js` → `src/engine.js` (`create()` is the single command
dispatch point); one module per concern under `src/`; `template/` is the payload copied into
each scaffolded site.

---

## Release order — do not improvise this

Every step below exists because skipping it has burned this project at least once.

**Steps 1–4 are the default end of a piece of work. Step 5 onward needs the operator to
ask.** Finish, verify, bump, commit, push, confirm CI — then stop and report. Do not treat
publishing as the obvious next step and do not tee it up as one. The operator runs their own
manual create-to-destroy pass on real Laragon first: on 2026-08-12 a single such teardown
surfaced four defects, three of them in text written in the previous two days, after a run of
four same-day releases. Their hands-on pass finds what the unit suite and code review do not.
Keep the version bumped regardless — `main` must never reuse a published version's number —
since bumping is not publishing.

1. **Verify locally.**
   - `node --check` every changed `.js`/`.mjs`.
   - `node index.js doctor` → must exit 0. Force a blocker
     (`AGENTPRESS_LARAGON_ROOT=C:/nope node index.js doctor`) → must exit 1.
   - **Run a real scaffold** if anything on the scaffold path changed. Code review does not
     catch composed-output bugs — see "Live testing" below for the recipe and why.
2. **Commit.** Branch, then merge to `main` with `--no-ff`.
3. **Bump the version in `package.json`. This is mandatory, not optional.** npm refuses to
   republish an existing version with different content, so an unbumped version cannot ship
   at all. Minor for new user-visible behaviour or a new env var; patch for pure fixes.
4. **Push to GitHub:** `git push origin main` — **then check CI actually went green**:
   `gh run list --repo briansmith80/agentpress --limit 1`. There IS a workflow
   (`.github/workflows/ci.yml`, windows-latest) and it is easy to forget because nothing
   locally tells you about it. During the 1.8.0 work six pushes went out on a red pipeline.
   **CI runs without PHP, Laragon, MySQL or WordPress, so `npm test` passing locally does
   not mean CI passes** — that exact gap is what broke it: a test's PHP-unavailable escape
   watched for a status string the code had stopped returning, invisible on a machine with
   PHP. To reproduce a runner locally, point `AGENTPRESS_LARAGON_ROOT` at a path with no PHP.
5. **`npm publish`** — needs a **real terminal**. 2FA requires a browser confirmation;
   non-TTY shells fail with `EOTP` and have no web fallback. An agent generally cannot do
   this step; hand the command to the user.
6. **Verify the publish actually landed — two checks, not one.**
   - `npm view create-agentpress version` must print the new version. *1.1.0 was believed
     published and never landed — auth had gone silently stale. `npm view … versions` still
     shows the gap: 1.0.0, 1.0.1, 1.2.0, 1.3.0.*
   - Then verify **contents**, not just the number: download the published tarball
     (`npm pack create-agentpress@X.Y.Z`) and grep for something you just added. A correct
     version number over stale files looks identical from the outside.
7. **Create the GitHub release** — a push alone does **not** update the repo's advertised
   version; that comes from the release/tag:
   ```
   gh release create vX.Y.Z --repo briansmith80/agentpress --target main \
     --title "AgentPress X.Y.Z — <summary>" --notes-file <notes.md>
   ```
   Match the existing notes style: user-facing `##` sections explaining *why each change
   matters*, and disclose known-broken behaviour rather than omitting it.
8. **Update `HANDOFF.md`.**

`package.json`'s `files` allowlist is `["index.js","src","template","SECURITY.md"]` — a new
top-level directory shipping code **will not be published** unless it's added there. Check
with `npm pack --dry-run`.

---

## Live testing is the real test suite

There **is** a fast unit suite now — `npm test`, ~54 cases under `test/`, no Laragon or
network needed, and `prepublishOnly` runs it. Run it on every change. It does **not**
replace the live run: it covers pure functions, string invariants and filesystem work, and
by construction cannot see anything that only appears once Apache, PHP and WordPress are
composed together.

Most real bugs in this project were found by running it against real Laragon, not by
inspection and not by the unit suite. v1.7.0 is the standing example: a change that passed
review and every unit test corrupted `.htaccess` on the first real rewrite flush, because
WordPress matches its markers with `str_contains()` per line and a *comment* in our block
quoted one. Budget for the live run.

**Throwaway scaffold recipe:**

```
node index.js aptestNNN --yes --premium=none    # --premium=none unless testing premium
curl -sk -o /dev/null -w "%{http_code}" https://aptestNNN.test/hello-world/   # 200 = permalinks + .htaccess
curl -sk -o /dev/null -w "%{http_code}" https://aptestNNN.test/.env           # 404 = docroot correct
cd C:/laragon/www/aptestNNN && node <repo>/index.js destroy --yes
```

**Back up `~/.claude.json` first.** MCP wiring is `--scope user` (machine-global), so
scaffolding **repoints the live `wordpress` MCP connection** at the test site, and destroying
that site then **removes the entry entirely** — leaving no MCP wiring at all. Snapshot the
`mcpServers` block before, restore it after. Restore only that block; the rest of the file is
live session state.

Expect a **UAC prompt** for the hosts-file write. Declining is non-fatal (the tool prints the
line to add by hand and completes).

After `destroy`, verify no residue: project dir gone, no conf in `sites-enabled`, absent from
`SHOW DATABASES`, absent from `~/.agentpress/environments.json`. A dangling hosts line is
expected and documented.

---

## Hard-won rules

**Zero npm dependencies, deliberately.** `package.json` has no `dependencies` key and
"nothing to `npm install`" is a design property. Hand-roll instead — `src/ansi.mjs` is ~15
lines of escape codes in place of chalk.

**The hosts file: a silently-failed read must never become a write.** On 2026-08-12 the
first hosts-removal left the machine's hosts file **EMPTY** — all ~90 entries gone — after
passing every offline check (matcher verified against a fake file with every trap, elevated
probe read 103 lines / 94 kept, identical script correct under PS 5.1 against a copy).
Mechanism, established afterwards: its `Get-Content -ErrorAction SilentlyContinue` returns
NOTHING on a failed read, the filter over zero lines produced an empty `$kept`, and
`Set-Content` persisted it. The read had every chance to fail: destroy had just deleted a
www folder, which is when Laragon — which rewrites the ENTIRE hosts file from a temp copy
on every sync — may be mid-rewrite of the same file. Restored byte-identical from a backup
taken minutes earlier. v2 (`hostsRemovalScript` in `src/wildcard.mjs`, shipped 1.9.0) is
allowed to rewrite because every step refuses that hole: .NET reads that THROW on failure,
an empty read aborts, only lines carrying a known tool tag are ever dropped — `#agentpress`,
plus `#laragon magic!` for the destroyed hostname where destroy opts in (operator's call,
2026-08-12: Laragon only prunes its dead lines when a NEW folder appears in www, so the
last site's line lingered forever), and never an untagged line a human wrote — plus a
caller-computed cap on removed lines, a STRICT UTF-8 decode (the lenient default turned an
ANSI "café" comment into U+FFFD and persisted it file-wide, invisible to the verify), and a
temp-file swapped in via `File.Replace` with a REAL backup filename — never `Move-Item
-Force`, which on PS 5.1 deletes the destination FIRST (proven live: a held handle left NO
hosts file, reported as "nothing was changed"), and never `$null` as Replace's backup arg,
which PowerShell binds as `""` and throws "path is not of a legal form" on every call.
Post-write verify restores from the freshest backup if the file ever reads back empty — and
it runs BEFORE the folder delete, out of Laragon's rewrite window. Any change to that script
keeps ALL of those properties, keeps the JS/PS matcher parity test green, and gets a live
append→remove **byte-identity** round-trip on a real machine before shipping.

**Never spawn a competing Apache.** Tried and reverted: it restores the TCP port with a
*stale in-memory config*, serving every existing site while silently 404ing the new one —
worse than a clear outage. Detect and report; recovery is the user's Stop All → Start All.
`laragon.exe reload` is unreliable for the same reason; "instant mode" (`setup`'s wildcard
vhost) exists to bypass reloads entirely.

**Windows `spawn` cannot launch `.cmd`/`.ps1` shims with `shell:false`.** `claude`, `codex`,
`gh`, `wp.bat` all resolve to shims. Route through `psRun()`/`psCapture()` in `src/win.mjs`.
This bug shipped silently twice.

**`spawnCapture`/`psCapture` never throw — always check `.code`.** Assumed success is the
root cause of the two worst silent failures in this project's history (MCP wiring recorded as
done while nothing was registered; `destroy` reporting a dropped database that wasn't).

**Environment variables are strings.** `Boolean(process.env.X)` is true for `"0"`, so
`FORCE_COLOR=0` and `NO_COLOR=0` — the conventional spellings of *off* — read as *on*. Use
`envOn()` in `src/ansi.mjs`. Same class of bug: `'C:\Windows'` in a single-quoted JS string
evaluates to `C:Windows`, because `\W` is not an escape sequence.

**ANSI escapes count toward `String.length`.** Pad the **raw** string, then colour.
`green(x).padEnd(26)` silently eats 9 columns; `x.padEnd(26)` then colour is correct. All of
`doctor`'s layout depends on this.

**Status colour must not cry wolf.** `doctor` uses green ✓ healthy / yellow ⚠ real
non-blocking warning / red ✖ blocker / cyan → next action / dim · information. Information
stays uncoloured so a ✓ still means something. Never mark a row `warn` whose own text says
"normal", "harmless", or "ignore".

**`template/scripts/agentpress.mjs` is frozen into every scaffolded site and must stay
import-free.** It cannot import from `src/` (that doesn't exist beside a scaffolded site), so
it carries deliberate duplicated copies (`ADMIN_LOGIN_PHP`, `BANNER_LINES`, the colour gate).
Changing one copy means changing both — verify parity programmatically, not by eye. Existing
sites only pick up changes when `update` is run in them.

**`wp eval-file` needs a literal `<?php` tag** (unlike `wp eval`). Without it the payload
prints itself instead of executing.

**Secrets.** Admin login links are single-use with a ~300s TTL — always mint fresh, never
reuse or paste an old one. Per-site secrets live only in each site's gitignored `.env`. Never
commit or echo generated passwords, app passwords, or license keys.

---

## Style

Comments explain **why**, not what, and cite the live-verified failure that motivated them —
often naming the exact symptom ("served every pre-existing site fine, silently 404'd the new
one"). Match that density and voice. Read a file's header comment before editing it; several
encode failure modes that are not obvious from the code.

Prefer extending an existing seam over adding a call site: `doctor`'s `row()`/`blocked()`,
`win.mjs`'s `psRun()`, `wp.mjs`'s spawn primitive.

---

## Known-broken, tracked but unfixed

Oxygen's `html-to-page` MCP tool fails on **every** input on 6.2.0-beta.2 — the builder's
`parse_fragment()` pairs a leading `<meta charset>` with `LIBXML_HTML_NOIMPLIED`, which trips
a spurious "Memory allocation failed" on libxml ≥ 2.10. Workaround is `edit-post` +
`insert-stylesheet`. The break ships from the **cached premium zip** in
`~/.agentpress/premium-plugins/`, so every scaffold installs it. Candidate fixes and the
full diagnosis are in `PLANNING/TODO.md`; this needs a scope decision, not a patch.
