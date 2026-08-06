# Planning & TODO

> **Active plan: "make every scaffolded site prove itself"** (below). Written 2026-08-06.
> Nothing in it is built yet.
>
> Items 2–5 of the previous plan shipped in **v1.3.0**; they're summarised at the bottom with
> the durable lessons only. The full 575-line text is preserved in git —
> `git show 27875d7:PLANNING/TODO.md`. Item 1 — the Oxygen `html-to-page` breakage — was never
> fixed and is now Phase 1 here.

---

# Active plan — make every scaffolded site prove itself

## Why these are one piece of work, not three

`html-to-page` is the documented way to build Oxygen pages and it currently fails on **every**
input. Fixing it unlocks the clean route to generating a homepage. And the homepage worth
generating is one that *proves the stack works* — WordPress, Oxygen, the abilities pack, both
MCP servers — which in turn re-exercises the `html-to-page` fix on every scaffold. Each piece
makes the next one worth doing.

Sequenced deliberately: **Phase 1 is independently useful and ships alone.** It is the only
part that is actively broken for every user today.

## Decisions taken (2026-08-06)

| # | Question | Decision | Why |
|---|----------|----------|-----|
| 1 | Where to apply the Oxygen fix | **Post-install patcher, guarded** | Patching the cached zip alone cannot hold: `wp plugin update --all` runs *after* premium install and re-fetches the vendor build. Only a post-update patch survives |
| 2 | How to build the homepage | **Via `html-to-page`, after Phase 1** | Oxygen's own documented path; the result stays editable in the builder, and every scaffold re-proves the fix |
| 3 | Card values | **Live**, not baked | Baked values are wrong *before the scaffold finishes* — `updateAllPlugins` runs after page creation and can change both the Oxygen version and the plugin count |
| 4 | The two MCP rows | **Agent-verified** (supersedes "reframe the labels") | The site cannot know either fact. The agent can, because it is the connected party. See Phase 3 |
| 5 | Existing sites | **Backfill via `update`** | Same precedent as the v1.4.0 security guard; otherwise every existing site stays broken with no route to a fix short of re-scaffolding |
| 6 | Homepage default | **On, with `--no-homepage`** | A scaffold should land somewhere useful rather than on "Hello world" |

---

## Phase 1 — fix Oxygen `html-to-page`

### Evidence (measured 2026-08-06, PHP 8.4.14 / libxml 2.11.9)

`parse_fragment()` in `oxygen/plugin/mcp/design/html-to-page.php:182` wraps input as
`'<meta charset="utf-8"><div id="__bdmcp_root__">' . $html . '</div>'` and calls `loadHTML`
with `LIBXML_HTML_NODEFDTD | LIBXML_HTML_NOIMPLIED`. Three wrappers tested against five inputs:

| Wrapper | Result |
|---|---|
| `<meta charset="utf-8">` (current) | **Fails on every input** — `Memory allocation failed`, no root node |
| `<?xml encoding="utf-8"?>` | **Works on all inputs, UTF-8 intact** (`café — ✓ 日本語`) |
| No prefix at all | Parses, but **silently mangles UTF-8** (`café` → `cafÃ©`) |

The third row is why the fix is not "just delete the meta tag": that trades a loud failure for
quiet corruption. The `<meta charset>` was there to carry the encoding, and the `<?xml
encoding?>` form is the replacement that still does.

The repro harness is worth keeping — reproduce with the script pattern in this session's
scratchpad (`libxml-repro.php`): three wrappers × five inputs, printing load status, first
libxml error, and round-tripped output.

### Scope confirmed on disk

- Cached zip `~/.agentpress/premium-plugins/oxygen-6.2.0-beta.2.zip` **ships the unpatched
  file** — so every scaffold installs the break.
- `agentpress-setup-test` (scaffolded, current) — **unpatched**, Oxygen `6.2.0-beta.2`.
- `oxygen-AI-test` (dev site) — patched by hand in an earlier session, with
  `html-to-page.php.bak-libxml211` beside it. This is why the bug looked intermittent.
- 6.2.0-beta.2 was still the newest build as of 2026-08-04 research; **re-check before
  building** — if upstream shipped a fix, this whole phase collapses to "bump the zip".

### Where it goes

`src/engine.js` `finishExtras`, immediately **after** `updateAllPlugins()` (currently line
~877) and before `wireMcpForSite()`. Anywhere earlier and the update step undoes it.

### Guards — all of these, or it doesn't ship

The patcher must be a no-op unless it is certain. Specifically:

- Only when the **exact** current broken string is present. If the vendor's line has changed at
  all, skip and **report that it skipped** — never fuzzy-match, never regex-rewrite blindly.
- Only when `LIBXML_VERSION >= 21000`. Below that the vendor code is fine and patching would be
  gratuitous.
- **Idempotent** — detect the already-patched form and do nothing.
- **Back up** the original alongside (`.bak-libxml`, matching what the dev site already has).
- **Report loudly** in the scaffold output: which file, why, and that it's a vendor patch.
- **Non-fatal.** A failure to patch must not fail the scaffold — report and continue.
- **Opt out** via an env var (e.g. `AGENTPRESS_NO_VENDOR_PATCH=1`), documented in `help` and
  the README alongside the other env vars.

### Policy: this is the first time the tool edits a file it does not own

`update`'s doc comment (`src/engine.js:1113-1126`) currently draws the line explicitly — it
refreshes "only AgentPress-owned files", with **one** deliberate exception (the loopback guard),
justified because those are "files AgentPress owns outright".

A vendor patch is a **stronger** exception and needs its own written justification in that same
comment, not a silent widening. The case for it: the alternative is shipping a builder whose
primary documented tool fails on 100% of input, on every site, with no route to a fix. The case
against, which should also be recorded: it is a commercial third party's code, the patch can
silently stop applying when they change the file, and a user may not expect it. The guards above
exist to make all three failure modes visible rather than silent.

### Also

- **Backfill via `update`** (decision 5), following the `writeMcpLoopbackGuard` precedent at
  `src/engine.js:1282`.
- **Tests** — the guard logic is pure string work, so it unit-tests without Laragon: patched
  input unchanged, broken input fixed, vendor-changed input skipped-and-reported, old libxml
  skipped. Add to `test/`.
- **Report upstream — still not filed.** A ready-to-paste draft exists from the 2026-08-04
  research; file at `soflyy/agent-connector-for-wp` (Issues enabled, five live Oxygen 6.2 MCP
  bugs already filed there), *not* `oxygen-bugs-and-features` (Oxygen Classic only). Lead with
  the libxml version — their CI likely runs < 2.10, which is probably why it shipped. The report
  is now much stronger than it was: we have the three-wrapper comparison proving the fix and
  ruling out the naive alternative.

---

## Phase 2 — a status page at scaffold time

### What the site can truthfully report (all local, all instant — verified)

WordPress version · PHP version · Oxygen version · active theme · **active plugin count (5)** ·
site host · Agent Connector active · **abilities registered (52)**.

That last one is a better signal than "connected": it is the number that actually drops when
something breaks.

### What it cannot

- **Playwright MCP status.** Playwright MCP runs on the developer's machine driving a browser.
  It never contacts WordPress. Checked: the only site-side mentions of "playwright" are prose in
  an ability description and a `package-lock.json`. The site cannot know this, ever.
- **Whether any agent is attached.** The proxy is stateless HTTP; there is no session to observe.

Baking "connected" as a snapshot is the *worst* option, because MCP wiring is machine-global —
the next scaffold steals it, so an older site's page would keep claiming "connected" exactly
when it had been disconnected. That is the confusion `rewire` exists to fix. Hence Phase 3.

### Build

- Author the page as **semantic HTML + a `<style>` block**, hand it to `html-to-page`. Depends
  on Phase 1; also means every scaffold re-proves Phase 1 still works.
- Reference implementation already exists: page ID 5 on `agentpress-setup-test`, built by hand
  with the `edit-post` workaround. Structurally simple — **only `OxygenElements\Text` (21) and
  `OxygenElements\Container` (12)**, so nothing exotic to reproduce. Its values are all
  hardcoded literal text, which is exactly what decision 3 changes.
- **Live values** need a shortcode or small mu-plugin the page calls; the Oxygen Text element
  must render shortcodes for this to work — **verify that before committing to the approach.**
- **Fallback when Oxygen isn't installed** (`--premium=none`): a plain page, no builder. Note
  the active theme is `oxygen-zero`, which is deliberately blank — check what a non-Oxygen page
  actually renders as under it before assuming a plain page looks acceptable.
- **Never clobber an existing front page.** Fresh scaffolds have none, but `resume`/`update`
  paths must not overwrite a homepage the user has since built.
- One unverified row, pointing at Phase 3: *"Agent verification: not yet run — open Claude Code
  and run `/verify`."*

---

## Phase 3 — the agent verifies, then regenerates the page

The idea that resolves Phase 2's honesty problem: **the agent is the only party that can verify
MCP connectivity, because it is the connected party.** So it runs a real end-to-end test on
first use and rewrites the page with results that actually happened.

This matches a principle already established in v1.5.0 — MCP wiring was changed from *asserted*
to *verified against a live endpoint*. Same move, applied to the site.

### What `/verify` does

1. Call a WordPress MCP tool → proves wiring, auth, and that the loopback containment guard
   still permits legitimate local access.
2. Drive **Playwright MCP** to load the site and screenshot it → proves browser automation and
   that the site serves.
3. Optionally mint an admin login link and confirm `wp-admin` loads → proves the abilities pack
   end to end.
4. Collect the real values, regenerate the page via `html-to-page` with verified rows plus a
   timestamp, and set it as the front page.

### The determinism risk — design against it now

If the agent is told "build a status page", it produces a different page every run and the
thing stops being a test. **The command must carry the exact HTML/CSS**, so the agent fills in
only values it measured. Same page every time, different data — that is what makes it a
regression check rather than a vibe.

### Delivery

- **`AGENTS.md`** scaffolded into each site, written so any agent can follow it. This closes an
  existing audit finding (previous handoff, Next Step 4: "scaffolding a CLAUDE.md/AGENTS.md into
  each site"). Confirmed: sites currently ship **no** agent instructions at all.
- **`.claude/commands/verify.md`** for the one-word Claude Code path.
- The scaffold summary and the per-site menu should both point at it, or nobody will find it.
- **Cross-agent caveat:** slash commands are Claude Code-only, and per the previous handoff only
  Claude Code is actually exercised on this machine. Codex/Cursor/OpenCode would get the
  `AGENTS.md` route, written-but-unverified — the same standing caveat as their MCP wiring.

### Open questions

- Where does the canonical HTML/CSS template live so the CLI (Phase 2) and the agent (Phase 3)
  emit *the same page*? A single source both read is the only way they don't drift — the
  `test/parity.test.mjs` pattern already used for the frozen menu is the obvious model.
- Does the Playwright screenshot get stored in the site (media library? `.agentpress/`?) or just
  taken and discarded as proof?
- Should `/verify` be re-runnable as a health check after `rewire`, refreshing the timestamp?
  (Probably yes — that is when the page most needs to become true again.)

---

## Still open, unrelated to the above

- **Cursor CLI binary name unverified.** `src/agents.mjs` probes `cursor-agent`; an audit claims
  the shipped Windows binary is now `agent`. Deliberately not changed on a guess — needs someone
  with Cursor installed to run `Get-Command`.
- **Only Claude Code is exercised end to end.** Codex's teardown guard is additionally
  known-weak: `codex mcp get` masks env values, so the ownership check cannot match.
- From the original audit, still unfixed: progress output during the multi-minute download steps
  (a stuck run and a slow run look identical); an `info`/`open` command; a `snapshot`/`rollback`
  pair via `wp db export`; `WP_DEBUG` on by default; `src/secrets.mjs` truncating to ~41 bits of
  entropy; the scaffold summary printing the admin password to stdout even when an agent is
  capturing it; no Windows Firewall check in `doctor`.

---

## Shipped in v1.3.0 — durable lessons only

Items 2–5 of the previous plan (Playwright discoverability, colour/glyphs, `doctor` SSL rows,
the wordmark banner) all shipped. Full detail: `git show 27875d7:PLANNING/TODO.md`. What is
worth remembering:

- **ANSI escapes count toward `String.length`.** Pad the raw string, then colour.
  `green(x).padEnd(26)` silently eats 9 columns. All of `doctor`'s layout depends on this.
- **Status colour must not cry wolf.** A healthy run's only ⚠ was a row whose own text said
  "harmless" — which teaches the reader to ignore yellow. Information rows are uncoloured so a ✓
  still means something.
- **Environment variables are strings.** `Boolean(process.env.X)` is true for `"0"`, so
  `FORCE_COLOR=0` read as *on* and beat `NO_COLOR`. Fixed with `envOn()` in `src/ansi.mjs`.
- **A real scaffold found what three adversarial reviews missed.** The one-click admin link was
  minted with the site's hostname but not its scheme, so following it made WordPress report
  `http://` as its own address — the actual cause of the "https site shows http" report. Code
  review cannot catch composed-output bugs; this is why `RELEASING.md` mandates a live scaffold.
- **Back up `~/.claude.json` before any test scaffold.** MCP wiring is machine-global:
  scaffolding repoints it and destroying the test site removes it entirely. Learned when the
  restore step printed `(none)`.
