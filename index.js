#!/usr/bin/env node
import { create } from './src/engine.js';
import { envOn, red, BAD } from './src/ansi.mjs';

create().then(
  // Respect process.exitCode — failure paths set it to 1, and a hard
  // process.exit(0) here would erase that (scripts chained with && used to
  // proceed after a failed scaffold).
  () => process.exit(process.exitCode || 0),
  (err) => {
    // This was `console.error(err)`, i.e. a raw stack trace. It is the ONLY
    // rejection handler in the tool, so every unhandled throw — lock contention,
    // a bad Laragon root in `setup`, a teardown aborted half-way — surfaced as
    // Node internals instead of the ✖ line with a next action that every
    // deliberate failure path prints. A stranger cannot tell those apart.
    //
    // The stack still matters when something is genuinely unexpected, so it is
    // behind AGENTPRESS_DEBUG rather than deleted. envOn, not Boolean: an env var
    // is a string, so `AGENTPRESS_DEBUG=0` must mean off (see ansi.mjs).
    const message = err instanceof Error ? err.message : String(err);
    console.log(`\n${red(BAD)} ${message}`);
    if (envOn('AGENTPRESS_DEBUG')) {
      console.log('');
      console.log(err instanceof Error && err.stack ? err.stack : err);
    } else {
      console.log('  This one was unexpected. Run `doctor` to check the environment, and set');
      console.log('  AGENTPRESS_DEBUG=1 to see the full stack trace.');
    }
    process.exit(1);
  },
);
