#!/usr/bin/env node
import { create } from './src/engine.js';

create().then(
  // Respect process.exitCode — failure paths set it to 1, and a hard
  // process.exit(0) here would erase that (scripts chained with && used to
  // proceed after a failed scaffold).
  () => process.exit(process.exitCode || 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
