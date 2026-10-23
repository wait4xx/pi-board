#!/usr/bin/env node
// cli/piboard.ts — the piboard CLI entrypoint (exposed as the `piboard`
// bin by package.json). Pure dispatcher (mirror of the pi-mesh cli/mesh.ts
// pattern): every command lives in cmd/ and the only logic here is arg
// dispatch — SPECS per command, parse errors and help are uniform.
import { parseArgs, specUsage, type ArgSpec } from "./args.js";
import { say, sayErr } from "./out.js";
import { EXIT_OK, EXIT_USAGE } from "./codes.js";
import { cmdJoin, JOIN_USAGE } from "./cmd/join.js";
import { cmdWrite, parseWriteArgs, WRITE_USAGE } from "./cmd/write.js";
import { cmdRead, READ_USAGE } from "./cmd/read.js";
import { cmdGrep, GREP_USAGE } from "./cmd/grep.js";
import { cmdWatch, WATCH_USAGE } from "./cmd/watch.js";
import { GENERAL_USAGE, printCommandHelp, printGeneralUsage } from "./cmd/help.js";

const JOIN_SPECS: ArgSpec[] = [
  { name: "observer", kind: "flag", help: "join read-only (writes refused)" },
  { name: "alias", kind: "value", meta: "A", help: "peer alias (default $PI_BOARD_ALIAS or \"board\")" },
];

const WRITE_SPECS: ArgSpec[] = [
  { name: "type", kind: "value", meta: "T", help: "OBSERVED | FACT | FAIL | CLAIM | PATCH_SUMMARY" },
  { name: "text", kind: "value", meta: "TXT", help: "summary line (≤280 chars)" },
  { name: "detail-file", kind: "value", meta: "PATH", help: "long form file, or - for stdin" },
  { name: "ref", kind: "value", meta: "R", help: "git-reachable anchor (path, commit, URL)" },
  { name: "claim-id", kind: "value", meta: "ID", help: "claim correlation id" },
  { name: "lease-ref", kind: "value", meta: "L", help: "mesh_claim lease id (annotation only)" },
  { name: "room", kind: "value", meta: "ROOM", help: "override the room for this write" },
];

const READ_SPECS: ArgSpec[] = [
  { name: "id", kind: "value", meta: "ID", help: "unfold this entry's detail" },
  { name: "limit", kind: "value", meta: "N", help: "window size (capped)" },
  { name: "room", kind: "value", meta: "ROOM" },
];

const GREP_SPECS: ArgSpec[] = [
  { name: "type", kind: "value", meta: "T", help: "filter by entry type" },
  { name: "limit", kind: "value", meta: "N", help: "max rows (default 50)" },
  { name: "room", kind: "value", meta: "ROOM" },
];

const WATCH_SPECS: ArgSpec[] = [{ name: "room", kind: "value", meta: "ROOM" }];

function usageError(usage: string, reason: string): number {
  sayErr(reason);
  sayErr(usage);
  return EXIT_USAGE;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || command === "") {
    printGeneralUsage();
    return EXIT_USAGE;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    const topic = argv[1];
    if (topic !== undefined && !printCommandHelp(topic)) {
      return usageError(GENERAL_USAGE, `no such command: ${topic}`);
    }
    if (topic === undefined) printGeneralUsage();
    return EXIT_OK;
  }

  switch (command) {
    case "join": {
      const res = parseArgs(argv.slice(1), JOIN_SPECS);
      if (!res.ok) return usageError(JOIN_USAGE, res.error);
      if (res.help) {
        say(`${JOIN_USAGE} ${specUsage(JOIN_SPECS)}`);
        return EXIT_OK;
      }
      return cmdJoin(res.parsed.positionals[0], {
        observer: res.parsed.flags.has("observer"),
        alias: res.parsed.values.get("alias"),
      });
    }
    case "write": {
      const res = parseArgs(argv.slice(1), WRITE_SPECS);
      if (!res.ok) return usageError(WRITE_USAGE, res.error);
      if (res.help) {
        say(`${WRITE_USAGE} ${specUsage(WRITE_SPECS)}`);
        return EXIT_OK;
      }
      if (res.parsed.positionals.length > 0) {
        return usageError(WRITE_USAGE, "write takes no positional arguments");
      }
      const parsed = await parseWriteArgs(res.parsed.values);
      if (!parsed.ok) return usageError(WRITE_USAGE, parsed.error);
      return cmdWrite(parsed.args);
    }
    case "read": {
      const res = parseArgs(argv.slice(1), READ_SPECS);
      if (!res.ok) return usageError(READ_USAGE, res.error);
      if (res.help) {
        say(`${READ_USAGE} ${specUsage(READ_SPECS)}`);
        return EXIT_OK;
      }
      if (res.parsed.positionals.length > 0) {
        return usageError(READ_USAGE, "read takes no positional arguments");
      }
      return cmdRead(res.parsed.values);
    }
    case "grep": {
      const res = parseArgs(argv.slice(1), GREP_SPECS);
      if (!res.ok) return usageError(GREP_USAGE, res.error);
      if (res.help) {
        say(`${GREP_USAGE} ${specUsage(GREP_SPECS)}`);
        return EXIT_OK;
      }
      if (res.parsed.positionals.length > 1) {
        return usageError(GREP_USAGE, "grep takes exactly one query argument");
      }
      return cmdGrep(res.parsed.positionals[0], res.parsed.values);
    }
    case "watch": {
      const res = parseArgs(argv.slice(1), WATCH_SPECS);
      if (!res.ok) return usageError(WATCH_USAGE, res.error);
      if (res.help) {
        say(`${WATCH_USAGE} ${specUsage(WATCH_SPECS)}`);
        return EXIT_OK;
      }
      if (res.parsed.positionals.length > 0) {
        return usageError(WATCH_USAGE, "watch takes no positional arguments");
      }
      return cmdWatch(res.parsed.values);
    }
    default:
      sayErr(`unknown command "${command}"`);
      printGeneralUsage();
      return EXIT_USAGE;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    sayErr(`piboard: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
