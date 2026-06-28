#!/usr/bin/env node
import process from "node:process";

import { run } from "./main.js";

run(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
