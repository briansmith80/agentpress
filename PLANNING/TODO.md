# Planning & TODO — items 1–5

> Status: **plan agreed 2026-08-04, implementation in progress.**
> Created 2026-08-04 from a set of live-usage observations. Each item was
> traced back to the actual code before writing anything down here — see
> "Findings" under each item for the file/line grounding. Update HANDOFF.md
> when this lands.

## Decisions log (2026-08-04)

Settled before implementation started, so none of these get re-litigated:

| # | Question | Decision | Why |
|---|----------|----------|-----|
| 1 | Colour approach | **Hand-rolled ANSI, zero dependencies** (`src/ansi.mjs`) | `package.json` has no `dependencies` key and that is a stated design property — chalk/picocolors would break it for ~15 lines of escape codes |
| 2 | Oxygen `html-to-page` bug scope | **Document + report only**, no code workaround | May be fixed upstream; don't build a permanent workaround around a transient beta bug |
| 3 | Where the bug gets filed | **Research the tracker first, then ask again** | Oxygen is commercial; unclear whether a public tracker exists. Nothing gets posted publicly without explicit approval |
| 4 | npm publish | **Commit locally only** — no version bump, no publish | npm publishes are irreversible per version, and HANDOFF records that 2FA needs a real terminal for the browser confirmation |
| 5 | Banner placement | ~~Per-site menu + `setup` only~~ → **REVERSED: every command** (see 5a) | — |
| 5a | Banner placement (final, 2026-08-04) | **Every command gets it as a header**, via one call at the `create()` dispatch point in `engine.js:1265`. Exception: `--version`/`version`. | User request, overriding the original recommendation. Implemented at dispatch rather than per-command so it cannot drift out of sync as commands are added. `--version` is excluded because its bare `create-agentpress vX.Y.Z` output is the machine-readable one people script against. `AGENTPRESS_NO_BANNER=1` remains the escape hatch if it ever gets noisy, and non-TTY/`NO_COLOR` runs suppress it automatically |
| 6 | `Welcome to agentpress vX.Y.Z.` line | **Fold into the banner subtitle** (`v1.2.0 · AI-agent-ready WordPress`) | Version stays visible, less vertical space. Fallback: print the plain line when the banner is suppressed, so the version never disappears entirely |

**Correction to the approved mockup.** The mockup marked several healthy rows
with an amber ⚠ (`Instant mode ACTIVE`, `exif extension: enabled`, `Defender
real-time: on`). That was a mockup error, not the intended semantics —
colour that cries wolf is worse than no colour. Implementation uses a
5-level vocabulary instead, with a dim `·` for rows that carry information
but imply no judgement:

| Glyph | Colour | Means |
|-------|--------|-------|
| `✓` | green | healthy / done |
| `⚠` | yellow | real warning, may want action, **not** blocking |
| `✖` | red | blocker, must fix before scaffolding |
| `→` | cyan | next action / in progress |
| `·` | dim | pure information, no judgement implied |

---

## 1. Oxygen `html-to-page` MCP tool broken on 6.2.0-beta.2

**Observed:** `html-to-page` fails to parse even trivial input (`<p>Hello world</p>`, plain text with no tags), while the lower-level `edit-post` and
`insert-stylesheet` tools work fine. Likely a bug in the beta builder
plugin, not this tool's setup.

**Findings:**

- The WordPress MCP server's own instructions confirm `html-to-page` is the
  *documented preferred path* for new pages/sections, with `edit-post` +
  `insert-stylesheet` as the intended fallback for fine-grained edits and
  anything `html-to-page` can't express — i.e. the fallback you found
  working is the sanctioned one, not a hack.
- `src/plugins.mjs` → `updateAllPlugins()` runs `wp plugin update --all` on
  **every scaffold**, deliberately, so "the Oxygen family updates from the
  vendor" to whatever is "current" (doc comment at `plugins.mjs:314-321`).
  That means a beta build can land on a site without anyone opting into a
  beta channel — the vendor's update feed is just currently serving one.
  This is a plausible root cause for *why* 6.2.0-beta.2 showed up at all.
- No code in this repo controls or pins Oxygen's release channel today —
  `updateAllPlugins()` just calls `wp plugin update --all` unconditionally.

**Decision (2026-08-04):** Document + report only, no code change yet. This
may simply get fixed upstream, and we don't want to build a permanent
workaround around a transient beta bug.

**Tasks:**

- [ ] Add a short "Known issues" note to `README.md`: `html-to-page` can
  break on Oxygen beta builds — use `edit-post` + `insert-stylesheet`
  instead (this is the documented fallback, not a workaround).
- [ ] File the bug upstream with Soflyy/Oxygen against 6.2.0-beta.2, with a
  minimal repro (`<p>Hello world</p>`, and plain text with no tags at all).
- [ ] Note the `updateAllPlugins()` → vendor-latest-channel connection in
  this doc (done above) so it isn't rediscovered from scratch later if the
  same thing happens again with a different plugin.

**Revisit when:** Oxygen ships a stable release past 6.2.0-beta.2 — confirm
`html-to-page` works again, then remove the known-issue note.

### Tracker research findings (2026-08-04) — ROOT CAUSE FOUND

The research pass answered decision 3 and went considerably further: it found
the actual bug, on disk, with a one-line fix.

**Root cause.** `parse_fragment()` in
`oxygen/plugin/mcp/design/html-to-page.php` wraps input as
`'<meta charset="utf-8"><div id="__bdmcp_root__">' . $html . '</div>'` and calls
`loadHTML($wrapped, LIBXML_HTML_NODEFDTD | LIBXML_HTML_NOIMPLIED)`. On
**libxml ≥ 2.10** that combination throws a spurious "Memory allocation
failed", `loadHTML` returns false, the root node is never built, and
`parse_fragment()` returns `null` — so **every** input fails, which is exactly
why bare text with no tags failed too. This machine runs PHP 8.4.14 /
libxml 2.11.9. Surfaced error: `breakdance_html_to_page_parse_failed`.
Fix that works: `'<?xml encoding="utf-8"?>'` instead of the `<meta charset>`
prefix.

**Where it belongs.** `html-to-page` ships in the **builder**
(`oxygen/plugin/mcp/tools/html-to-page.php`), *not* in
`agent-connector-for-wp` — verified on disk, zero matching files in the
connector. But the tracker that accepts it is the connector's:
[`soflyy/agent-connector-for-wp`](https://github.com/soflyy/agent-connector-for-wp/issues)
has Issues enabled and its 5 open issues (#78–#82) are all Oxygen 6.2 MCP
bugs filed by outside users in late July 2026. **Do not** file on
`soflyy/oxygen-bugs-and-features` — its README says Oxygen **Classic** only.
Public fallback with no login: <https://oxygenbuilder.com/support/>.

**No existing public report** covers this, and **6.2 is still beta** —
beta.2 (25 Jul 2026) is the newest release, so nothing newer fixes it. A
report is warranted.

**Two caveats that must go in the report:**
- **This install is no longer a clean repro.** A previous session already
  patched the live file (`<?xml encoding…>` is in place, with the original
  preserved at `html-to-page.php.bak-libxml211`) — consistent with HANDOFF
  item 9, which records rebuilding the Oxygen zip with fixes to this exact
  file. Say so in the report.
- **Version mismatch to resolve first:** `oxygen/plugin.php` reads
  `6.2-beta.1`, not beta.2. Confirm the real version in wp-admin before filing.

### VERIFIED ON DISK — the broken build ships from our own cached zip

Not a hypothesis any more. Checked directly:

| What | State |
|---|---|
| `~/.agentpress/premium-plugins/oxygen-6.2.0-beta.2.zip` → `oxygen/plugin/mcp/design/html-to-page.php` | **UNPATCHED** — ships the broken `<meta charset>` + `NOIMPLIED` wrapper |
| `agentpress-setup-test/public/.../html-to-page.php` (the site in the screenshot) | **UNPATCHED**, Oxygen `6.2.0-beta.2` |
| `oxygen-AI-test/.../html-to-page.php` (dev site) | **PATCHED**, with `html-to-page.php.bak-libxml211` beside it |

So the chain is: the **cached premium zip contains the unpatched file**, every
scaffold installs from that zip, and therefore **every newly scaffolded site
gets a broken `html-to-page`**. The dev site works only because it was patched
in place by hand in an earlier session.

This contradicts HANDOFF item 9's claim that "the oxygen zip was REBUILT with
two fixes to `plugin/mcp/design/html-to-page.php`" — whatever was rebuilt, the
zip now sitting in the cache is not it. Either the rebuild never reached this
cache, or vendor beta.2 landed afterwards and replaced it, or
`updateAllPlugins()` (`wp plugin update --all`, which runs at the end of every
scaffold and pulls the vendor's current build) overwrote the patched files
post-install. All three are consistent with what's on disk; distinguishing them
needs one scaffold with the update step watched.

**This makes item 1 locally fixable, independent of upstream** — which changes
its shape from "document and wait" to a real choice:
- **(a)** Re-patch the cached zip (and the private releases repo it syncs from),
  so scaffolds stop shipping the break; and/or
- **(b)** Re-apply the patch post-install in `plugins.mjs`, after
  `updateAllPlugins()` — survives vendor builds clobbering it, but means
  carrying a vendor patch in this tool; and/or
- **(c)** Stop `updateAllPlugins()` from pulling the Oxygen family, so a pinned
  known-good build stays put. Note the existing doc comment says the Woo shim
  zip *relies* on that update step, so this needs care.

Not actioned — it's a scope decision, and (b) in particular means this tool
would start shipping a third-party patch.

**Still needs a decision (decision 3 remains open):** a ready-to-paste report
draft exists, but nothing has been filed — filing posts publicly under the
owner's identity, so it stays a manual step. Two open sub-questions: whether
issue creation on the connector repo is actually open (an unauthenticated
fetch returned "Issue creation is restricted", which may be an
anonymous-visitor artifact — check while logged in), and whether to pin the
Oxygen family out of the auto-update path so vendor builds stop clobbering
local patches.

---

## 2. Playwright MCP is wired but never mentioned

**Observed:** Playwright is installed and working (confirmed via `claude mcp list`), but nothing in the tool's output ever said so.

**Findings:**

- `src/mcp.mjs` wires a Playwright MCP server (`@playwright/mcp@0.0.78`,
  pinned) for every detected agent, alongside the WordPress MCP — this is
  real, working, intentional (not accidental).
- It is mentioned in exactly **one** place: a single sentence buried in an
  architecture paragraph in `README.md:163`.
- The scaffold's own summary output (`engine.js:757`) prints
  `MCP wired for: claude` — it names the *agent*, never *what* got wired
  for it. `doctor.mjs` doesn't mention Playwright at all either.
- Net effect: a user only discovers Playwright MCP exists by reading that
  one README line closely, or by independently running `claude mcp list`.

**Decision:** Straightforward discoverability fix, low risk, no design
tradeoff — proceed as scoped below.

**Tasks:**

- [ ] `engine.js` (~line 757): expand the summary line to name both
  servers, e.g. `MCP wired for: claude (wordpress + playwright browser automation)`.
- [ ] `doctor.mjs`: extend the "AI agent CLIs" row (or add a line under it)
  to state that Playwright MCP is wired automatically alongside WordPress
  MCP for any detected agent — no separate install step needed.
- [ ] `README.md`: promote the current one-sentence mention (line ~163)
  into a short standalone callout — what Playwright MCP is for (browser
  automation / visual QA against the scaffolded site) and that it's
  automatic.

---

## 3. Improve the look and feel of doctor / setup / scaffold output

**Observed:** Output is plain text; want color + icons if feasible.

**Findings:**

- Zero color anywhere in the codebase today — no chalk/picocolors/manual
  ANSI, nothing.
- There's already a light iconography convention: ✓ / ✖ / → appear **81
  times** across `engine.js` alone, plus in `doctor.mjs`. Not starting from
  zero on the icon front.
- The project has a stated, deliberate "zero npm dependencies" design
  principle (`package.json` has no `dependencies` key at all; HANDOFF
  calls this out explicitly as intentional, not an oversight). A dependency
  like chalk would break that.
- `doctor.mjs` already has clean structural seams to build on: a `row()`
  helper for normal lines and a `blocked()` helper for blockers
  (`doctor.mjs:81-85`) — coloring can hook into these two functions instead
  of touching every call site.

**Decision (2026-08-04):** Hand-rolled ANSI, zero dependencies — keeps the
project's stated design principle intact.

**Tasks:**

- [ ] New `src/ansi.mjs` (or similar): minimal manual ANSI helpers (green /
  yellow / red / cyan / dim / bold), gated on
  `process.stdout.isTTY && !process.env.NO_COLOR` so it degrades cleanly
  for piped/non-TTY output and respects the `NO_COLOR` convention.
- [ ] `doctor.mjs`: color via the existing `row()` / `blocked()` helpers —
  green for healthy/ready rows, yellow for informational gaps (e.g.
  "instant mode off"), red for actual blockers; green/red for the final
  "Ready to scaffold: YES/NO" line.
- [ ] Extend the existing ✓/✖/→ convention with 1–2 more glyphs (e.g. ⚠ for
  warnings) applied consistently across `doctor.mjs` and `engine.js`.
- [ ] `template/scripts/agentpress.mjs` (the frozen per-site menu) — its own
  header comment notes it intentionally duplicates some logic from `src/`;
  apply the same color/icon treatment there too so the per-site menu and
  the main CLI don't visually diverge.
- [ ] Sanity-check rendering in: PowerShell 5.1, Windows Terminal, and
  piped output (e.g. `... | Out-File`) — must fall back to plain text
  automatically, never leak raw escape codes.

---

## 4. `doctor` shows :80 but not :443/SSL; WP Address shows `http://`

**Observed:** `doctor` reports port 80 but never port 443. A scaffolded
site's WordPress Address (URL) is `http://` and the user expected `https://`.

**Findings — this is a visibility gap, not a functional bug:**

- SSL support already exists in full: `wildcard.mjs` has `sslCertPresent()`
  and emits a real `:443` `<VirtualHost>` block (with `SSLEngine on`) when
  Laragon's cert pair is present.
- `engine.js`'s `setup` command already detects and reports https status in
  detail (~lines 1156-1189: "instant mode ACTIVE (http + https)", or
  guidance to enable SSL in Laragon's menu and re-run `setup` if not).
  `doctor.mjs` just never got the equivalent rows — today it only checks
  TCP :80 and the MySQL port.
- `wp-config.php`'s `WP_HOME`/`WP_SITEURL` are **dynamic per-request**,
  based on `$_SERVER['HTTPS']` (`wordpress.mjs:116-118`) — not hardcoded to
  http. The Settings → General screen in wp-admin reflects whatever scheme
  *that specific page load* used.
- At scaffold time, `engine.js` already picks `https` over `http` live when
  SSL is actually up (`sslCertPresent()` + a real TLS probe via
  `fetchViaLoopback`, e.g. `engine.js:514-515`, `:872`) and threads that
  `scheme` through `finishInstall`/`finishExtras` into `.env`'s
  `SITE_SCHEME` and the minted admin-login link.
- Conclusion: a site showing `http://` almost certainly means SSL wasn't
  live on the machine *at scaffold time* (cert not present yet, or Apache
  hadn't picked up the wildcard's https vhost after the one-time restart
  `setup` calls for) — and `doctor` currently gives no way to see that,
  which is why it read as "wrong" rather than "expected, here's why."

**Decision:** Add the missing visibility to `doctor`; no change needed to
the scheme-detection logic itself, which is already correct.

### ROOT CAUSE FOUND (2026-08-04, by live scaffold test) — there WAS a real bug

The "no change needed" conclusion above was **wrong**, and only a real scaffold
found it. `aptest1300` scaffolded on an SSL-enabled machine printed:

```
Site   https://aptest1300.test
Admin  http://aptest1300.test/?acfw_login=...
```

The site is https; the **one-click admin link is http**. Cause:
`mintAdminLoginUrl()` (`src/admin-login.mjs`) rewrote the minted URL's
`hostname` and `port` but never its `protocol`. WP-CLI runs with no
`$_SERVER['HTTPS']`, so wp-config.php's per-request `WP_HOME` resolves to
`http://` and the link comes back http even for an https site.

Because `WP_HOME`/`WP_SITEURL` are derived per request, **following that http
link makes WordPress report `http://` as its own WordPress Address in
Settings → General** — which is exactly the symptom originally reported. So
the observation was correct and the diagnosis of "expected, SSL just wasn't
live at scaffold time" was incomplete.

Verified live over the same site: requesting over https makes WP emit
`https://aptest1300.test`; requesting over http makes it emit
`http://aptest1300.test`. Confirms the mechanism.

**Fixed** by forcing `url.protocol = \`${scheme}:\`` in
`src/admin-login.mjs`, plus the same fix in the per-site menu's own duplicated
`adminUrl()` (`template/scripts/agentpress.mjs`). Proven by minting a real link
against the live test site: now returns `https://…`, protocol `https:`.

**Lesson worth keeping:** this class of bug is invisible to code review and to
`doctor` — it only appears in the composed output of a real scaffold. It is the
one defect the whole review pass missed, and the reason the scaffold test was
worth running before publishing.

**Tasks:**

- [ ] `doctor.mjs`: add a "TCP :443 (SSL)" row and an "SSL certificate" row,
  reusing `sslCertPresent()` and `wildcardActive({ tls: true })` from
  `wildcard.mjs` (same functions `engine.js` setup already uses) rather
  than duplicating the logic.
- [ ] When SSL isn't live, doctor should give the same actionable next step
  `setup` already prints ("enable SSL in Laragon's menu, then re-run
  setup") instead of just being silent about it.
- [ ] ~~Optional: surface the *actual* scheme an already-scaffolded site is
  running on by reading `SITE_SCHEME` from that site's `.env`~~ —
  **deferred.** `doctor` is a machine-level check that isn't run from inside
  a site directory, so it has no single site's `.env` to read. The per-site
  menu already shows the site's real scheme (it reads `SITE_SCHEME` itself).
- [ ] Explicitly note in the doc/README that this is a visibility fix —
  avoid over-scoping into touching the (already-correct) scheme-detection
  or wp-config logic.

---

## 5. ASCII art banner on the per-site menu (`npm run agentpress`)

**Observed:** the per-site interactive menu currently opens straight into
the site's connection info (WordPress/Admin/Username/Password) and a plain
`Welcome to agentpress v1.2.0.` line — no branding moment.

**Findings:**

- `template/scripts/agentpress.mjs:63-67` already hand-rolls its own
  zero-dependency ANSI helpers — `COLOR` (gated on
  `isTTY && !NO_COLOR && !CI`), a truecolor-aware `PINK`, `pink()`, `dim()`.
  This is exactly the pattern agreed for item 3, already proven live in the
  actual product — good prior art to match, and a reason to keep the two
  color approaches visually consistent rather than inventing a second style.
- No ASCII-art dependency exists or is needed — a static block-letter string
  constant is enough; no figlet-equivalent package required, keeping the
  file's "dependency-free by design" comment (line 2-4) true.
- Verified (not hand-typed): a compact 4×5 block-letter wordmark for
  AGENTPRESS renders at a fixed 49 columns wide, generated and checked
  programmatically for row-width consistency before going anywhere near a
  mockup — see the artifact for the actual rendered result.

**Proposed placement:** immediately after the `npm run agentpress` /
`node scripts/agentpress.mjs` npm-wrapper lines, before the
WordPress/Admin/Username/Password block — a banner-then-site-info-then-menu
order, colored with the same `pink()` helper already in the file.

**Resolved (was an open question):** the standalone `Welcome to agentpress
vX.Y.Z.` line **folds into the banner subtitle** (decision 6), and the
banner goes on **the per-site menu + `setup`, not `doctor`** (decision 5).
One wrinkle the fold introduces and the implementation must handle: when the
banner is suppressed (`!COLOR`, non-TTY, `AGENTPRESS_NO_BANNER`) the version
would otherwise appear nowhere at all — so the plain `Welcome to agentpress
vX.Y.Z.` line is retained as a fallback in exactly that case.

**Constraint that shapes the implementation:** this file is **copied into
every scaffolded site and frozen there**, and is import-free by design (it
cannot `import` from `src/` — that doesn't exist next to a scaffolded site).
So the banner art is **duplicated** here rather than imported, matching the
documented duplication already in place for `ADMIN_LOGIN_PHP`. The two copies
must be kept in sync; a review step diffs them character-for-character rather
than eyeballing them. Consequence: **existing scaffolded sites won't show the
banner until `update` is run** in them.

**Tasks:**

- [ ] Finalize the exact glyph set/width in `template/scripts/agentpress.mjs`
  (verify programmatically the same way as the mockup, not by hand-typing
  into the file).
- [ ] Print it once at menu startup, before the site info block, using the
  existing `pink()` helper — no new color/style system needed.
- [ ] Decide whether to keep or fold in the separate `Welcome to agentpress vX.Y.Z.` line (see open question above).
- [ ] Confirm it degrades cleanly under the file's existing `COLOR` gate
  (`NO_COLOR`, non-TTY, CI) — same as every other colored line in this file.

---

## Implementation notes (written during the build)

**`src/ansi.mjs` (new) — the shared contract.** Written and smoke-tested
first, before anything else, because doctor/engine/menu all depend on its
exact API. Exports `COLOR`, `green/yellow/red/cyan/dim/bold/pink`,
`OK/WARN/BAD/STEP/INFO`, `mark(status)`, `tint(status, text)`, and
`banner(subtitle)`. The gate is `FORCE_COLOR || (isTTY && !NO_COLOR && !CI
&& TERM!=='dumb')` — matching the `NO_COLOR` convention and the gate
`template/scripts/agentpress.mjs` already shipped, so the two look like one
product rather than two colour systems.

*Verified, not assumed:* piped output and `NO_COLOR=1` both emit **zero**
escape bytes (checked with `cat -A`), column alignment survives both, and
the banner suppresses itself rather than dumping five rows of U+2588 into a
log file.

**The one real trap, documented in the file header:** ANSI escapes count
toward `String.length`, so `padEnd` must run on the **uncoloured** string.
`green(label).padEnd(26)` silently loses 9 columns per cell; `label.padEnd(26)`
then colouring is correct. `doctor.mjs`'s whole layout is `padEnd(26)`-based,
so this was the highest-risk part of the change and gets an explicit review
lens of its own.

**`sslPortUp()` added to `src/laragon.mjs`, deliberately NOT to `preflight()`.**
A closed `:443` is a completely normal state (SSL simply not enabled) and
http scaffolds work fine without it — so gating on it would be wrong. More
importantly `probeWithRetry` costs up to ~4.8s on a genuinely closed port,
which **every scaffold** would then pay for no benefit. `doctor` calls it
directly instead, where a couple of seconds buys a real answer.

**Banner art is generated, never hand-typed.** Hand-drawn ASCII art drifts a
column and nobody notices until it ships. Trailing whitespace is trimmed on
purpose so a whitespace-stripping editor or lint hook can't reshape it —
nothing follows on the line, so it renders identically.

**Known caveat — console codepage.** The banner uses U+2588 (`█`). Verified
on this machine: active code page is **65001 (UTF-8)** and PowerShell 5.1's
`OutputEncoding` is utf-8, so it renders correctly here. A machine still on a
legacy codepage (437/1252) would show mojibake instead. Accepted rather than
fixed, because:
- the codebase already emits `✓ ✖ → ⚠` in ~81 places and has shipped through
  v1.2.0 across two machines, so the exposure is identical and already proven
  in practice;
- detecting the codepage would mean spawning `chcp` on every menu start — a
  real cost for a purely decorative element, in a file whose whole design
  point is being fast and dependency-free;
- `AGENTPRESS_NO_BANNER=1` is the escape hatch, and nothing breaks if it
  mojibakes — the banner is decoration, not information.
Worth revisiting only if a real user reports it. The difference from the
existing glyphs is that 5 rows of garbage is *visually* much louder than one
wrong character, so it may deserve the codepage check if it ever bites.

---

## Review outcomes (2026-08-04) — what the verification pass caught

Three independent adversarial reviews ran over the combined diff. Two
reviewers **independently** confirmed the same top defect, which is why it was
treated as real rather than as a style opinion.

### Fixed — real bugs

1. **`FORCE_COLOR=0` turned colour ON, and beat `NO_COLOR`.** My bug in
   `ansi.mjs`. `Boolean(process.env.X)` is the wrong test for env vars: values
   are strings, so `Boolean('0') === true`. `FORCE_COLOR=0` is the conventional
   spelling of "disable colour" (chalk/supports-color honour it, CI images set
   it), and because it was the *first* `||` clause it also defeated `NO_COLOR=1`.
   Proven by a reviewer with 28 raw escape lines landing in a redirected file —
   violating the exact rule the docstring three lines above claimed to enforce.
   Fixed with an `envOn()` helper treating `''/0/false/no/off` as off, and
   `NO_COLOR` checked first so an explicit "off" always wins.
   **Verified after the fix:** `FORCE_COLOR=0`, `NO_COLOR=1 FORCE_COLOR=1`, and
   a plain pipe all emit **0** escape bytes; `FORCE_COLOR=1` emits 34.
2. **`AGENTPRESS_NO_BANNER=0` suppressed the banner** — same truthy-`'0'` class,
   both copies.
3. **`(:d{1,5})?` in the per-site menu's `safeHost()`** — pre-existing, unrelated
   to this work. A bare `d`, not `\d`, so it matched a literal "d" and **any
   `SITE_HOST` carrying a port was rejected outright**, bailing the menu with
   "not a valid hostname".
4. **`'C:\Windows'` in single-quoted JS → `C:Windows`** — pre-existing, in *two*
   places (`agentpress.mjs` rundll32 fallback, `engine.js` explorer fallback).
   `\W` isn't a recognised escape so the backslash was dropped, breaking both
   fallbacks on any machine with `%SystemRoot%` unset.
5. **My `~4.8s` figure in `laragon.mjs` was wrong by 4×** and contradicted a
   pre-existing comment 20 lines above. Measured: a closed loopback port returns
   ECONNREFUSED in single-digit ms, so the cost is the two 600ms sleeps ≈ 1.2s;
   `tcpProbe`'s 1000ms timeout is never reached. The decision to keep
   `sslPortUp()` out of `preflight()` still stands — the number justifying it
   didn't.
6. **The two colour gates diverged while both files asserted they matched.** The
   menu's gate lacked `FORCE_COLOR` and the `TERM=dumb` check, so
   `FORCE_COLOR=1 … | cat` coloured the main CLI but not the menu. Aligned, and
   the menu's ANSI block hoisted above its early bails so those failure messages
   can be red too (they were bare `✖` next to red `✖` from `engine.js`).

### Fixed — status semantics (the "colour that cries wolf" problem)

Both reviewers independently found the same thing, and one proved it by running
`doctor` for real: on a healthy machine the **only** yellow ⚠ in the whole run
was a row whose own text said "harmless". That teaches the reader to ignore
yellow — worse than no colour at all.

| Row | Was | Now | Why |
|---|---|---|---|
| `TCP :443` closed | `warn` | `info`, or `warn` only if a cert exists | Text says "normal… http scaffolds work fine". Yellow reserved for the genuinely odd case: cert present but not serving |
| `SSL certificate` absent | `warn` | `info` | SSL simply not being enabled is a fully supported setup |
| `exif extension` absent | `warn` | `info` | Text says "harmless for most sites" |
| `hosts entries` unreadable | `warn` | `info` | Text says "or ignore — scaffold will prompt" |
| `AI agent CLIs` none found | `warn` | `info` | Optional, never auto-installed — same reasoning the WP-CLI row already used |
| `upload/post max` | always `info` | `warn` when `post_max_size < upload_max_filesize` | **Caught a real problem on this machine: `50M / 8M`** — the actual upload ceiling is 8M, and the row explained the rule then passed no judgement on it |
| `memory_limit` | always `info` | `warn` below 256M | `128M` and `512M` looked identical; one of those breaks Oxygen |

Also: the `AI agent CLIs` row now lists **only agents actually found** — it used
to print every candidate including "not found" ones and tint the whole string
green, so three "not found"s rendered as successes.

### Fixed — alignment and polish

- `LABEL_WIDTH` raised 26 → 30. `'Defender real-time protection'` is 29 chars,
  so it was the one row whose value column hung right of every other row's —
  in a table whose entire purpose is a scannable column.
- Verdict footer indent aligned to the glyph column.
- `(not just Reload)` added to `doctor`'s Stop All guidance. It was in
  `engine.js` and missing from `doctor` — load-bearing, because Reload
  genuinely doesn't work for this.
- `AGENTPRESS_NO_BANNER` / `NO_COLOR` / `FORCE_COLOR` documented on `help`'s
  `Env:` line (the new var was documented nowhere).
- README: Playwright was measured at **first mention on line 192 of 288, in zero
  `##` headings** — invisible to a skimmer. Promoted to its own `##` heading and
  added to the opening "One command gives you" paragraph.

### Verified clean (proven, not assumed)

- **No ANSI-in-`padEnd` anywhere.** The highest-risk part of the change.
  Confirmed mechanically: `FORCE_COLOR=1` output with escapes stripped is
  **byte-identical** to the plain piped run.
- **The 74 glyph conversions in `engine.js` did zero collateral damage.** A
  reviewer normalised every colour wrapper back out and diffed against HEAD:
  the only content change in 1340 lines is the intended MCP summary line. No
  lost `\n`, no dropped backtick, no reworded failure message.
- **Every `✖` failure path kept its full recovery text** (`resumeHint`,
  `doctor`, `Stop All → Start All`) — this project's rule that failures name the
  exact recovery command holds.
- **`sslPortUp()` is not in `preflight()`** — scaffolds pay nothing.
- **The https probe is genuinely guarded** — `www\` had 90 folders before and
  after, no `ap-probe-*` residue.
- **The per-site menu is still import-free**, and the version still prints when
  the banner is suppressed.
- **Banner art byte-identical across both copies** — SHA-verified by a reviewer
  and re-checked after my edits (widths `49,46,48,49,48` in both).

### Open — deliberately not changed

- **`ok` rows tint their value green as well as the glyph.** A reviewer argues
  for dropping the value tint (keeping the green ✓) so that *coloured text*
  means "needs your attention" — on a healthy run that's 1 coloured phrase
  instead of 16. The argument is good, but the approved mockup showed green
  values, so this is a live design question rather than a defect. Left as-is
  pending a call.
- **`doctor` now runs two `wildcardActive` probes** (http + https) instead of
  one, ≈6.2s total. Acceptable for a diagnostic; noted so it isn't a surprise.
- **East-Asian-Ambiguous width:** `⚠` and `→` render double-width on a
  CJK-locale console, which would shift those rows one column. Width-1 confirmed
  here (incl. under `chcp 437`); pre-existing bet since `engine.js` already
  shipped these glyphs, but `doctor` is the first place they carry alignment
  meaning.

---

## Suggested sequencing (once we're ready to execute)

1. **Items 2 + 4** — both are small, contained `doctor.mjs`/`engine.js`/
   README edits with no open design questions. Good to batch together
   first.
2. **Item 3** — touches the same files as 2/4 (`doctor.mjs`, `engine.js`)
   plus the frozen template script; do after 2/4 land to avoid rebasing the
   color pass on top of moving text.
3. **Item 1** — no code change, purely documentation + an external bug
   report; independent of the others, can happen any time.
4. **Item 5** — independent file (`template/scripts/agentpress.mjs`), no
   dependency on 2/3/4; can land whenever, but do it alongside item 3 if the
   goal is one consistent "styled CLI" pass rather than two separate ones.
