---
description: Verify this site's MCP wiring, Oxygen and abilities end to end, then build its holding page
---

Verify this AgentPress site end to end, then build its holding page from the
template below. Work in order and **stop at the first failure** — report what
broke rather than working around it. A silent workaround here defeats the point:
the page is the evidence that the stack works.

## 1. Prove the WordPress MCP connection

Look at your own tool list for the `wordpress` server, then call the cheapest
read tool it offers — `site-info` if Oxygen is installed, otherwise
`mcp-adapter-discover-abilities`.

If that fails — especially with a 401 — the MCP wiring is stale. This happens
when another site was scaffolded after this one, because wiring is
machine-global. Stop and tell the user to run `agentpress rewire` from this
folder, then restart their session so the new password is picked up. Do not
attempt to work around it with wp-cli.

**Then decide which version of this check you are running.** If the tool list
has no `oxygen-*` tools, this site was scaffolded without Oxygen
(`--premium=none`). That is a supported setup, not a fault. Verify the WordPress
MCP and Playwright legs only, skip steps 3 and the Oxygen line in step 5, say
plainly that Oxygen was not installed, and stop there — there is no
`html-to-page`, so the holding page cannot be built and you should not fake one.

With Oxygen present, call `get-instructions` and then `get-breakpoints` before
building anything; the server requires the first and the second governs
responsive rules.

## 2. Collect the real values

Via MCP only — do not guess, and do not carry over numbers from earlier in the
conversation:

- WordPress version, PHP version, site host (`site-info`)
- Oxygen version and active theme
- **How many tools the `wordpress` MCP server exposes to you** — i.e. the number
  in your own tool list for that server, not a count from a REST endpoint or
  `wp_get_abilities()`. Those give different answers (37 / 48 / 52 on one site),
  because they count different things. The tool count is the one that matters:
  it is what you can actually call, and `agentpress rewire` reports the same
  number, so the page and the CLI agree.

## 3. Build the page

Create a page titled **Home**, pass the HTML below to `html-to-page`, and set it
as the site's front page.

Substitute every `{{PLACEHOLDER}}` with a value you actually measured. Use
today's date for `{{DATE}}`. Keep the markup and classes exactly as written —
this page doubles as a regression test, so it should come out the same every
run, with only the data differing.

## 4. Prove the Playwright connection

Load the site with Playwright and screenshot it. Then actually check the result:

- The wordmark must read clearly as **AGENTPRESS**, in pink, with the letters
  separated. If the SVG is missing or distorted, say so — do not accept it.
- The status card must be readable, dark, and not overflowing its container.
- Every row must show a real value. A `{{PLACEHOLDER}}` left on the page means
  you skipped a measurement.

Playwright writes the screenshot to a file. It is proof, not content, so delete
it once you have looked at it — a stray PNG in the project root is litter, and
in the site folder it would be publicly served.

## 5. Report

One line each, PASS or FAIL: WordPress MCP · Playwright MCP · Oxygen
html-to-page · Agent Connector abilities. Mark the Oxygen line SKIPPED, not
PASS, when Oxygen is not installed. If everything passed, say so plainly and
give the user the site URL.

---

## The page

```html
<style>
.ap-page{background:#0b0d11;min-height:100vh;padding:64px 24px;display:flex;flex-direction:column;align-items:center;gap:26px;font-family:'JetBrains Mono',monospace}
.ap-mark{width:100%;max-width:420px;height:auto;display:block}
.ap-head{color:#d8dbe2;font-size:26px;margin:0;font-weight:400}
.ap-sub{color:#8890a0;font-size:15px;margin:0}
.ap-card{background:#12151b;border:1px solid #262b34;border-radius:10px;padding:26px 30px;width:100%;max-width:560px;display:flex;flex-direction:column;gap:13px}
.ap-cmd{color:#ff2d78;font-size:15px;margin:0 0 6px 0}
.ap-row{display:flex;justify-content:space-between;gap:20px;border-bottom:1px dashed #262b34;padding-bottom:11px}
.ap-key{color:#8890a0;font-size:14px}
.ap-val{color:#d8dbe2;font-size:14px}
.ap-ok{color:#4fbf6d;font-size:14px}
.ap-exit{color:#5b6270;font-size:13px;margin:6px 0 0 0}
</style>
<section class="ap-page">
<svg class="ap-mark" viewBox="0 0 490 68" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AgentPress"><path d="M10 0h20v12h-20zM60 0h20v12h-20zM100 0h40v12h-40zM150 0h10v12h-10zM180 0h10v12h-10zM200 0h40v12h-40zM250 0h30v12h-30zM300 0h30v12h-30zM350 0h40v12h-40zM410 0h30v12h-30zM460 0h30v12h-30zM0 14h10v12h-10zM30 14h10v12h-10zM50 14h10v12h-10zM100 14h10v12h-10zM150 14h20v12h-20zM180 14h10v12h-10zM210 14h10v12h-10zM250 14h10v12h-10zM280 14h10v12h-10zM300 14h10v12h-10zM330 14h10v12h-10zM350 14h10v12h-10zM400 14h10v12h-10zM450 14h10v12h-10zM0 28h40v12h-40zM50 28h10v12h-10zM70 28h20v12h-20zM100 28h30v12h-30zM150 28h10v12h-10zM170 28h20v12h-20zM210 28h10v12h-10zM250 28h30v12h-30zM300 28h30v12h-30zM350 28h30v12h-30zM410 28h20v12h-20zM460 28h20v12h-20zM0 42h10v12h-10zM30 42h10v12h-10zM50 42h10v12h-10zM80 42h10v12h-10zM100 42h10v12h-10zM150 42h10v12h-10zM180 42h10v12h-10zM210 42h10v12h-10zM250 42h10v12h-10zM300 42h10v12h-10zM320 42h10v12h-10zM350 42h10v12h-10zM430 42h10v12h-10zM480 42h10v12h-10zM0 56h10v12h-10zM30 56h10v12h-10zM60 56h20v12h-20zM100 56h40v12h-40zM150 56h10v12h-10zM180 56h10v12h-10zM210 56h10v12h-10zM250 56h10v12h-10zM300 56h10v12h-10zM330 56h10v12h-10zM350 56h40v12h-40zM400 56h30v12h-30zM450 56h30v12h-30z" fill="#ff2d78"/></svg>
<h1 class="ap-head">$ site under construction</h1>
<p class="ap-sub">WordPress + Oxygen + Agent Connector + Laragon — building now</p>
<section class="ap-card">
<p class="ap-cmd">$ ./check-status.sh</p>
<div class="ap-row"><span class="ap-key">WordPress MCP</span><span class="ap-ok">● verified {{DATE}}</span></div>
<div class="ap-row"><span class="ap-key">Playwright MCP</span><span class="ap-ok">● verified {{DATE}}</span></div>
<div class="ap-row"><span class="ap-key">WordPress</span><span class="ap-val">{{WP_VERSION}}</span></div>
<div class="ap-row"><span class="ap-key">PHP</span><span class="ap-val">{{PHP_VERSION}}</span></div>
<div class="ap-row"><span class="ap-key">Oxygen Builder</span><span class="ap-val">{{OXYGEN_VERSION}}</span></div>
<div class="ap-row"><span class="ap-key">Theme</span><span class="ap-val">{{THEME}}</span></div>
<div class="ap-row"><span class="ap-key">MCP tools available</span><span class="ap-val">{{MCP_TOOLS}}</span></div>
<div class="ap-row"><span class="ap-key">Site</span><span class="ap-val">{{SITE_HOST}}</span></div>
<p class="ap-exit">exit 0 — all checks passed</p>
</section>
</section>
```

If a check **failed**, do not write `exit 0 — all checks passed`. Replace that
line with what actually happened, and mark the failed row honestly rather than
showing a green dot. An inaccurate status page is worse than none.
