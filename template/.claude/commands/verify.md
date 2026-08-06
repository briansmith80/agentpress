---
description: Verify this site's MCP wiring, Oxygen and abilities end to end, then build its holding page
---

Verify this AgentPress site end to end, then build its holding page from the
template below. Work in order and **stop at the first failure** — report what
broke rather than working around it. A silent workaround here defeats the point:
the page is the evidence that the stack works.

## 1. Prove the WordPress MCP connection

Call `get-instructions`, then `get-breakpoints`, then `site-info`.

If any of these fail — especially with a 401 — the MCP wiring is stale. This
happens when another site was scaffolded after this one, because wiring is
machine-global. Stop and tell the user to run `agentpress rewire` from this
folder. Do not attempt to work around it with wp-cli.

## 2. Collect the real values

Via MCP only — do not guess, and do not carry over numbers from earlier in the
conversation:

- WordPress version, PHP version, site host (`site-info`)
- Oxygen version and active theme
- How many abilities are registered

## 3. Build the page

Create a page titled **Home**, pass the HTML below to `html-to-page`, and set it
as the site's front page.

Substitute every `{{PLACEHOLDER}}` with a value you actually measured. Use
today's date for `{{DATE}}`. Keep the markup and classes exactly as written —
this page doubles as a regression test, so it should come out the same every
run, with only the data differing.

## 4. Prove the Playwright connection

Load the site with Playwright and screenshot it. Then actually check the result:

- The wordmark must render as **five separate lines**. If it collapsed into one,
  the whitespace was lost — fix it and re-check.
- The status card must be readable, dark, and not overflowing its container.

Take the screenshot but do not save it into the site; it is proof, not content.

## 5. Report

One line each, PASS or FAIL: WordPress MCP · Playwright MCP · Oxygen
html-to-page · Agent Connector abilities. If everything passed, say so plainly
and give the user the site URL.

---

## The page

```html
<style>
.ap-page{background:#0b0d11;min-height:100vh;padding:64px 24px;display:flex;flex-direction:column;align-items:center;gap:26px;font-family:'JetBrains Mono',monospace}
.ap-mark{color:#ff2d78;font-size:13px;line-height:1.2;white-space:pre;margin:0}
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
<div class="ap-mark"> ██   ██  ████ █  █ ████ ███  ███  ████  ███  ███
█  █ █    █    ██ █  █   █  █ █  █ █    █    █
████ █ ██ ███  █ ██  █   ███  ███  ███   ██   ██
█  █ █  █ █    █  █  █   █    █ █  █       █    █
█  █  ██  ████ █  █  █   █    █  █ ████ ███  ███</div>
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
<div class="ap-row"><span class="ap-key">Abilities registered</span><span class="ap-val">{{ABILITIES}}</span></div>
<div class="ap-row"><span class="ap-key">Site</span><span class="ap-val">{{SITE_HOST}}</span></div>
<p class="ap-exit">exit 0 — all checks passed</p>
</section>
</section>
```

If a check **failed**, do not write `exit 0 — all checks passed`. Replace that
line with what actually happened, and mark the failed row honestly rather than
showing a green dot. An inaccurate status page is worse than none.
