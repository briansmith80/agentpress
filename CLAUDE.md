# CLAUDE.md — working on AgentPress

Guidance for Claude Code working in this repo. **Not user documentation** — that's
[README.md](README.md). Session-by-session narrative lives in `HANDOFF.md`; in-flight
plans live in `PLANNING/`. Both are the maintainer's local files, gitignored on purpose —
if you cloned this repo they will not exist, and nothing in `src/` depends on them.

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
2. **Commit directly to `main`, and only when the operator says the work is done.** Edits
   accumulate in the working tree across the whole stretch — build, test, fix, iterate —
   and commit + push happens at the READY moment (the operator saying so, or an agreed
   milestone like publishing), not per item. The operator corrected this twice in one day
   (2026-08-14): first the branch-per-fix pattern (a commit plus a merge bubble per change,
   unreadable graph), then commit-per-item (still too chatty). Verify before the commit as
   always; a branch remains fine only for genuinely large work you may need to abandon.
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
curl -sk -o /dev/null -w "%{http_code}" https://aptestNNN.test/package.json   # 404 = docroot is public/
cd C:/laragon/www/aptestNNN && node <repo>/index.js destroy --yes
```

**Do not put `/.env` back in that docroot check.** It was the recipe's check until
2026-08-19 and it had stopped testing anything. This machine carries a hand-written
server-scope deny (`C:\laragon\etc\apache2\alias\000-security-deny-secrets.conf`, with
`C:\laragon\www\.htaccess` as its primary copy, neither of them written by this tool)
whose `<FilesMatch>` matches `.env` by NAME, so Apache answers **403 before it looks at
whether the file exists**. Live-verified 2026-08-19: a `.pem` probe returned 403 while it
existed inside `public/` and 403 again after deletion, and a dotfile the pattern does not
match (`/.nonexistent-xyz`) returns 404, so there is no blanket dotfile rule. A WRONG
docroot answers 403 too, which is why the check could not fail. `package.json` is sound
because it exists only in the project root and no deny rule covers it: 404 means Apache is
serving `public/`, and 200 would mean it is serving the project root with the site's `.env`
and `.mcp.json` exposed. Any replacement needs that property, so check it against the deny
patterns above before trusting it.

**Back up `~/.claude.json` first.** MCP wiring is `--scope user` (machine-global), so
scaffolding **repoints the live `wordpress` MCP connection** at the test site, and destroying
that site then **removes the entry entirely** — leaving no MCP wiring at all. Snapshot the
`mcpServers` block before, restore it after. Restore only that block; the rest of the file is
live session state.

**Back up `~/.codex/config.toml` too, when Codex is installed.** Since 1.10.0 Claude Code
is wired per site (`.mcp.json`), so `~/.claude.json` came through the 2026-11-11 run
untouched. Codex is the machine-global one now: the scaffold repointed its `wordpress`
entry at the test site and nothing in this recipe said to snapshot it, so what it pointed
at before was lost. That same run found a bug older than it: Codex prints its env values
as `*****`, `destroy` looked for the hostname in that output, never found it, said the
entry "doesn't point at this site" and left Codex wired to a site that was gone.
`codexWordpressUrl` now reads the address from the config file. Proven live: destroy
reported "MCP entries removed for: codex" and the file held no trace of the test site.

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

**The elevated hosts script is locked and fingerprinted before the prompt.** It lives in
%TEMP%, which anything running as the user can write, for as long as the UAC prompt is up.
`elevatedLauncherScript` (the unelevated wrapper, `src/wildcard.mjs`) opens the file with
`FileShare.Read`, hashes it THROUGH that handle, compares with the digest of the bytes Node
wrote, and holds the lock until the elevated run ends. What runs elevated is still the same
file by `-File`: the two hosts scripts and how they execute were not touched, on purpose.
`test/core-review.test.mjs` runs the real wrapper unelevated (same line minus
`-Verb RunAs`) with a stand-in script that tries to open itself for writing and cannot.
`ensureHostsEntry` also refuses a name that is not local (`isLocalDevHostname`): `resume`
reads SITE_HOST from `.env`.

**`destroy` proves `.env` belongs to the folder before it removes anything.** The old
gates proved the FOLDER was a site; the database, its user, the application password and
the hosts line are all named by `.env`, and `.env` travels with a copy. Run inside a copy
of a site, destroy dropped the ORIGINAL's database (security review, 2026-11-11, read end
to end). `destroyTargetProblems` (`src/destroy.mjs`): DB_HOST must be this machine, and
SITE_HOST must be the folder name plus a suffix or the registry's hostname for that exact
folder. Checked in the command (before the preamble, under `--yes` too) AND inside
`destroySite`. Live-proven with a fake folder: refused on a foreign SITE_HOST, refused on
a remote DB_HOST, went through on a true match.

**A tunnel is loopback.** Laragon Share, ngrok and cloudflared run on this machine, so
REMOTE_ADDR is 127.0.0.1 for the whole internet. The guard mu-plugin now also refuses a
guarded route when a forwarding header is PRESENT (never believed, only used to refuse).
Live on a local site: 401 without the header, 403 with it, `wp/v2/posts` untouched. The
`.htaccess` block was left alone (v1.7.0 is why). A tunnel that adds no such header is
not caught; SECURITY.md says so.

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

**The output theme — every user-facing surface speaks this one language** (help, setup,
doctor, the scaffold, destroy, the site menu; audit 2026-08-14). All helpers live in
`src/ansi.mjs` (the frozen menu carries its own copies):

- **Glyphs are semantic, never decoration**: green `✓` done / yellow `⚠` real warning /
  red `✖` blocker / cyan `→` the user's next action / dim `·` information. The crying-wolf
  rule above governs all of them, not just doctor.
- **pink** is the single accent: things the user types (commands, flags, site names in
  prompts), the wordmark, selected menu items, section numbers. One accent, used sparingly —
  if everything is pink, nothing is.
- **bold** for section headers (`Commands`, `Setup`) and for the rare critical action phrase
  inside prose (`Stop All → Start All`). Not for emphasis of ordinary words.
- **dim** for meta and secondary text: hints, receipts, "you can do this later" notes,
  parentheticals. A receipt after an action is `  → past-tense line`, dim. Under NO_COLOR a
  receipt `→` and a next-action `→` are told apart by TENSE and position, not colour: a
  receipt is past-tense directly under its action, a next-action is imperative. (The registry
  table's `→` marker is a third use, allowed because its printed legend defines it in plain
  text.)
- **Prompts**: `? question [Y/n]: ` — capital = the Enter default; destructive defaults are
  always the safe option (Cancel first / [y/N]). Step lines mid-flow are `  … doing thing…`;
  progress belongs there, results belong in the summary.
- **Layout**: pad the RAW string, then colour (ANSI counts toward `String.length` — the rule
  doctor's columns live by). Two-space indent for body text under a glyph line. The banner
  prints once, from `create()`, never per-command.
- **Degrade**: every helper is an identity function under NO_COLOR/non-TTY, so all output
  must read correctly as plain text — colour may reinforce meaning, never carry it alone.

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

**Push and pull (`src/push.mjs` + `src/push/agentpress-push/agentpress-push.php`, 1.11.0).**
One PHP plugin runs on BOTH ends: the live one is reached over REST, the local one through
`wp agentpress-push run`, and Node only carries files between them. So a rule fixed in the
plugin is fixed for both directions, and a local-to-local run exercises the real code. As of
2026-11-11 exactly one real server has seen it (a shared host, cPanel + LiteSpeed,
PHP 8.4): connect, status, the dry run, the first full push, one design push and its undo
(both cleared the page cache by themselves), and one pull (a story and its image written
on live arrived locally; the .test address, local admin, its app password and the agent
plugins were kept), and `push undo --full` twice (it is a SWAP of the kept tables with
the live ones, so the second run undid the first; what it restored was the copy from the
failed first push, not the empty install, because each swap replaces the kept set).

- **Ownership decides everything: design is local's and only goes up, content is live's and
  only comes down.** The whole database moves only in `push --full` (first launch) and
  `pull`. Do not add a third path that merges rows.
- **Oxygen's own Design Library importer is not a base to build on.** Run twice against a
  site (6.2.1): it keeps the stories, but bins and recreates every template under a NEW id
  each run, publishes a second "Home" (`home-2`) when the page changed, and drops
  `_breakdance_block_settings`. Hence the in-place apply keyed on a permanent
  `_agentpress_uid` per design item.
- **The agent plugins are local-only, both ways** (`LOCAL_AGENT_PLUGINS`). They carry
  shell-exec and PHP-eval. The first full push copied the whole plugins folder and the
  copied database switched them on at the target; caught before any real server was touched.
  A push now skips their files AND drops them from the active list. Both halves or neither:
  files skipped with the plugin still listed is a missing-plugin error on live. A test pins
  the pair.
- **Sessions and application passwords never travel with a database copy.** The dev site's
  app password is the one its AI agent holds.
- **Nor does a password, on the way UP.** The first real full push left the dev `admin` on
  live as an administrator with the dev password (the one the menu header prints), next
  to a REST API listing usernames. `pushFull` now sends `scramble_arriving_passwords`, and
  `db_swap` gives every account that is not one of the receiving site's own administrators
  a random password, AFTER those administrators are put back (the order is pinned by a
  test, or it scrambles them too). Local proof: receiver's `admin` fingerprint unchanged,
  the copied editor account's changed. Operator's call, 2026-11-11; a pull deliberately does not ask for it.
  Not retroactive: accounts already copied by 0.1.3 or earlier keep the old password.
- **The connection key lives in a FILE, never `wp_options`.** A full copy replaces the
  options table mid-job; a key stored there vanishes at the swap and every later step 401s
  with the job half done.
- **The swap keeps the copy's active-plugin list, not the union with the target's.** With
  the union, a target that had WooCommerce (the source did not) answered its next request
  60 seconds late: WooCommerce found its options gone and reinstalled itself.
- **The design fingerprint rewrites block references on the tree string BEFORE
  `wp_json_encode`.** Encoded, every quote is escaped (`\"block\":140`) and the reference
  pattern matches nothing, so two identical designs with different block ids hashed
  differently: `push status` said "differs" straight after a push that said "nothing to
  push", and the pull guard (same hash) would have refused every pull.
- **A step is numbered `runId:i`, not `i`.** The receiver remembers the last answer per
  number so a retried request is answered once; a bare integer collides the moment one op
  runs twice in a session.
- **A PHP-backed test skips ONLY when PHP is missing** (resolver throws, or exit code null).
  PHP that ran and answered wrongly must fail. The first version skipped on any non-zero
  exit, which would have hidden a parse error in the plugin behind a green run.
- **The site menu's Live site items RUN the command, they do not reimplement it.** An
  item's value is its command line, so the plan, the questions and the refusals cannot
  drift from the tool's. Three things make that work: `CHECKOUT_CLI` is stamped into the
  menu so a site updated from a git clone pushes with that clone (`npx …@latest` is the
  last PUBLISHED version, older than the plugin the clone just installed); everything of
  ours the menu runs gets `AGENTPRESS_NO_BANNER=1` (operator screenshot, 2026-11-11: every
  pick reprinted the wordmark until the results were lost between five of them); and
  `AGENTPRESS_MENU=1` makes `say()` in `src/push.mjs` name the menu item to pick next
  instead of a long command. `MENU_LABELS` there and the menu's labels are pinned by
  `test/parity.test.mjs`. The pasted connection line is validated against one exact shape
  BEFORE it reaches a shell (`runInherit` is `shell: true`).
- **The site menu is one screen at a time, not a log** (operator's call, 2026-11-11, after
  the submenu turned the old one-line-per-pick log into a column of question marks). Menus
  draw on the terminal's ALTERNATE screen and repaint whole at each step. What a command
  PRINTS goes to the normal screen under one heading line and waits for a key: the
  alternate screen has no scrollback, so a long result shown there loses its top for good,
  and this way what is left after exit is a log of what was done, not of every menu looked
  at. Each result starts on a CLEAN normal screen (operator's call the same day, after
  three stacked "Check status" results read as a fault): `resultScreen()` goes to the
  bottom row and writes one line feed per row, which scrolls the old view up into the
  scrollback instead of erasing it. Blank rows between results when scrolling back are
  the price. Quick actions leave a receipt through `note()`, drawn under the next header, because
  a line printed on the spot is wiped by the repaint. Never `ESC[2J`/`ESC[3J`: the screen
  and scrollback from before the menu opened are the user's. `process.on('exit')` leaves
  the alternate screen, or a crash returns a prompt with no history that will not scroll.
  `docs/menu.svg` (built by `tools/hero.mjs`) shows this as three screens that replace
  each other: main menu, Live site, a push preview with no header.
- **A local-to-local test cannot see what a pre-installed plugin hides.** Both findings of
  the first real push (a shared host, cPanel + LiteSpeed, 2026-11-11) were invisible
  locally because every test target already had Oxygen: (1) the file sync skipped any folder
  NAMED `cache`/`backups`/`node_modules`, and Oxygen ships code in `Twig/Cache/`, so the push
  died AFTER the database switch with `Class "…\Twig\Cache\FilesystemCache" not found`;
  (2) empty folders did not travel, and Oxygen refuses to run without three of its (empty)
  upload folders. Code roots are now copied exactly (only `.git` skipped), name-based skips
  apply only directly under `uploads/`, and empty folders are listed, packed and created.
  To reproduce a bare server locally, strip the target first: park `Twig/Cache` and
  `rmdir` the three `uploads/oxygen/*` folders, push, expect "6 to send".
- **A push that "worked" can still show the old site: the server's page cache.** After the
  first real push `push status` said all equal while `/` answered `X-LiteSpeed-Cache: hit`
  with the empty pre-push WordPress ("My WordPress Blog"); a cache-busting query showed the
  real page. Two causes: nothing purged the cache, and the copied database had switched the
  host-installed `litespeed-cache` plugin OFF, so the one thing that could purge was not
  running. Plugin 0.1.2 sends `X-LiteSpeed-Purge: *` itself in `db_swap`, `db_undo` and
  `finish`, and keeps an active page-cache plugin active with its own options through a
  swap (`agentpress_push_page_cache_plugins`). Live-verified the same day with a design
  push (0.1.3, cache plugin active): `/` had been cached with the old footer, and the first
  request after the push answered `miss` with the new one, no manual purge. Which of the
  two purges did it (the raw header or the plugin's `litespeed_purge_all`) is not
  separated, and the header alone, with the cache plugin OFF, is still unproven. Check with
  `curl -s -D - -o /dev/null https://<site>/ | grep -i x-litespeed-cache` straight after a
  push: `miss` is right, `hit` with the old content means the purge did not land.
- **The key is a header, so a page cache sees every request as an anonymous GET, and
  `nocache_headers()` does not stop LiteSpeed.** Second finding on the real server, the
  moment the LiteSpeed Cache plugin was switched back on (it caches the REST API by
  default): a design-push dry run said "96 files live does not have" when live lacked ONE.
  The second download of `manifest.ndjson` in a session (uploads) was answered
  `X-LiteSpeed-Cache: hit` with the first (mu-plugins, themes), same address, different
  file. A real push would have re-sent and overwritten every upload on live, which are the
  editor's. And the stored copy was served to a request with NO key: a cache hit never
  reaches PHP, so never reaches the permission check. `Cache-Control: no-store, private`
  was being sent throughout and ignored. Plugin 0.1.3: `agentpress_push_never_cache()` runs
  first in the permission check (so a refusal is not cached either) with all three
  spellings (`DONOTCACHEPAGE`, `litespeed_control_set_nocache`, `X-LiteSpeed-Cache-Control:
  no-cache`), and `route()` in `src/push.mjs` adds a unique `ap_n` to every address. Both
  halves stay. Any new route goes through the same permission callback or it is cacheable.
  Probe: download the same session file twice and read `x-litespeed-cache` on the second.
- **A pull trusts the live site, so the receiver checks what it is handed** (security
  review, 2026-11-11, plugin 0.1.5). The two that mattered: `files_unpack` took any root
  and any file type, so a pack from live carrying `mu-plugins/x.php` was unpacked into the
  dev site and run by the next step; and WordPress builds the uploads folder from the
  `upload_path` OPTION, which arrives inside the copy, so a pull could be pointed at any
  folder on the developer's disk. Now: the sender names the roots a pack is for and the
  receiver refuses the rest (`roots` is required, a pack without it is an error); a pull
  passes `refuse_code` and `keep_theme`; `db_swap` keeps the receiver's own `upload_path`;
  the `uploads` root is only offered when it is really inside `wp-content`; `db_import`
  runs nothing but one `CREATE TABLE` for the table the record names. The path checks are
  made on REAL paths (`agentpress_push_is_inside`), because `plugins/AgentPress-Push/` and
  `plugins//agentpress-push/` are the receiver's own folder to Windows and a different
  string to a prefix test. `test/push-security.test.mjs` drives the real `files_unpack`
  against a fake wp-content (`test/php/unpack-harness.php`). Proven between two local sites
  with planted files and a hostile theme setting; NOT run against the real server. What no
  check can close: Oxygen design data can hold PHP that Oxygen runs. SECURITY.md says so.
- **The connection line is data until it is parsed, and `.env` gets the parsed form.** The
  URL parser DROPS line breaks, so `https://live.example/\nDB_NAME=other` passed every
  check and then wrote a `DB_NAME` line of its own into `.env`, which is last-wins and is
  what `destroy` reads. `parseConnection` refuses control characters, userinfo, a query
  and a fragment, and returns `origin + pathname`. Text from the other site goes through
  `shown()` before it is printed (titles, logins, error messages can carry escape codes).
- **A retried step is answered, not run again, and that needs a lock.** `request()`
  retries a lost reply. The kept reply (`step-<op>.json`, keyed on `seq`) only exists once
  the first attempt has finished, and a shared host's gateway gives up at 30 to 60 seconds
  while PHP carries on, so the retry used to arrive mid-run and both ran. `agentpress_push_run`
  takes a lock per session and op before it looks. The one-shot steps (`db_swap`, `db_undo`,
  `design_apply`, `design_undo`) go through `runOnce()`, which gives them a session and a
  `seq`: an undo is a swap, so run twice it was "nothing happened", reported as done.
  A download's body is read INSIDE the retry loop. None of this has been seen to fire
  against a real bad connection; `test/push-retry.test.mjs` covers the download and pins
  the rest.
- **Known limits from the same review, left alone on purpose:** `db_export` pages by OFFSET
  (slow on huge tables, can skip or repeat a row on a busy site); one pack for everything,
  no free-space check; `apold_` tables are kept with no command to drop them; a failed job
  restarts from the top; foreign-key names may collide on a second full copy (WooCommerce).
  Listed in SECURITY.md. Fix one of these with a real site that shows it, not from reading.
- **A host's control panel can change the table prefix under you, and the kept database
  is found BY prefix.** Seen 2026-11-11: `push status` stopped saying "Live still holds the
  database from before the last full copy". Nothing had dropped it. Every table had been
  renamed from `wp_` to a random prefix and `wp-config.php` rewritten, by the host's
  WordPress toolkit: its "security measures" checklist has the item "Change default
  database table prefix", and the operator's screenshot the same evening showed it
  applied, with 17 others (bot protection, no PHP in uploads, blocked sensitive files).
  `push status` has run with all of them on; a push or a pull has not; `has_undo` looks for `apold_<current prefix>`, so
  the `apold_wp_` set was simply no longer seen. It is still in that database, orphaned,
  and nothing here removes it. `info` reports `prefix`, which is how this was found; look
  there first when an undo "disappears". It also made the two ends differ, which until
  then nothing had exercised. Tested the same day between two local sites, one renamed to
  a different prefix by hand (tables, `<prefix>user_roles`, the prefixed usermeta keys):
  a pull and a full push each way, roles intact on the receiver, tables created under the
  receiver's own prefix, undo fine. NOT covered by that: a prefix with CAPITAL letters
  (the live one has them; MySQL on Windows lowercases table names, so it cannot be
  reproduced here), and a real server.
- **Not exercised by anything yet:** a real `post_max_size`, the
  wp-admin key page in a browser, any host that is not cPanel + LiteSpeed (nginx, Apache,
  a managed host), and `pull undo` anywhere but local (it only ever touches local).
  Say so rather than assume.
- **The chooser cuts every row to the window width, on the raw text.** Its repaint climbs
  one terminal row per entry it drew, so a row that wraps is two on screen and one in the
  count: each keypress left the question line behind (eight stacked "? Live site …" lines
  in a 75-column pane, operator screenshot 2026-11-11). `test/parity.test.mjs` runs the
  real chooser against a fake terminal at four widths. A new row type goes through `fit()`.
- **"Live does not have this file" is two different facts, and only a ledger tells them
  apart.** Uploads travel in `missing` mode by FILE, not by media row. A file that came
  down in a pull stays on local (nothing is ever deleted, and `pull undo` restores the
  database only), so once the editor deleted that image on live, the next design push
  saw a file live "does not have" and offered it back. Seen 2026-11-11 on the real
  server: test story and image deleted on live, dry run said "send media 10 files live
  does not have (5.2 MB)". Fix: `.agentpress-push-seen.json` in the site's project root
  (never under `public/`), written by every operation that leaves upload files on both
  ends (`push --full`, `pull`, a design push), tied to one live host. A design push holds
  back a missing file whose path is in it and prints a `leave media` line. No ledger (a
  site connected before this, or never synced) means nothing is held back. A dry run
  writes nothing, the ledger included. Proven between two local sites with an image's
  files moved aside: 8 held with the ledger, "send media 8 files" without it. NOT yet
  run against the real server. To send held files anyway, delete the ledger.

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

Oxygen's `html-to-page` MCP tool fails on **every** input unpatched — the builder's
`parse_fragment()` pairs a leading `<meta charset>` with `LIBXML_HTML_NOIMPLIED`, which trips
a spurious "Memory allocation failed" on libxml ≥ 2.10. **Still unfixed upstream as of
6.2.0-beta.3** (verified live 2026-08-12: beta 3's pristine file carries the same broken
wrapper line — its changelog's "html-to-page" fix was a different, PHP 7.4 parse-error bug —
and an MCP probe against a beta-3 site succeeded only because our patch was in place).
`patchOxygenHtmlToPage` in `src/plugins.mjs` carries the tool: exact-line match only,
original kept beside as `.agentpress-bak`, applied at scaffold after plugin updates and
re-applied by `update` — which is how it survived the beta 2 → beta 3 jump. If the vendor
ever edits that line the patch deliberately no-ops and says so; that is the moment to
re-diagnose, never to loosen the match. The upstream report is still unfiled; beta 3 ships
an in-band `report-bug` MCP tool that drafts the issue with environment attached — filing is
outward-facing, so it waits for the operator's go-ahead.
