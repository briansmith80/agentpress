#!/usr/bin/env node
import { create } from './src/engine.js';

create().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
