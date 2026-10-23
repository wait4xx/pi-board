// src/cli.ts — the `piboard` bin entry (package.json bin → dist/src/cli.js).
// Thin on purpose: the surface lives in src/cli/main.ts.
import { runCli } from "./cli/main.js";

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`piboard: unexpected failure: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
