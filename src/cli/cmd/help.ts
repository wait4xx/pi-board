// cli/cmd/help.ts — the general usage surface and per-command help.
// `piboard help` prints the general usage; `piboard help <cmd>` prints the
// command's usage line.
import { say } from "../out.js";
import { JOIN_USAGE } from "./join.js";
import { WRITE_USAGE } from "./write.js";
import { READ_USAGE } from "./read.js";
import { GREP_USAGE } from "./grep.js";
import { WATCH_USAGE } from "./watch.js";

export const GENERAL_USAGE = `piboard — shared context board for pi-mesh (v0.1)

usage: piboard <command> [options]

commands:
  join <room> [--observer] [--alias A]      join a room as member/read-only peer
  write --type T --text "..." [options]     append a typed entry
  read [--id ID] [--limit N]                newest window, or unfold one entry's detail
  grep "a,b&c" [--type T] [--limit N]       boolean search (, = OR, & = AND, ci)
  watch                                     print new FAILs since last watch
  help [cmd]                                this help

entry types: OBSERVED | FACT | FAIL | CLAIM | PATCH_SUMMARY
write options: --text "…" (required, ≤280 chars) · --detail-file -|PATH (long
  form, "-" = stdin, ≤8 KiB) · --ref R (git-reachable anchor) · --claim-id ID
  · --lease-ref L
room resolution: --room flag > $PI_BOARD_ROOM > the room saved by \`piboard join\`
exit codes: 0 ok · 1 error · 2 usage · 3 not_found (read --id) · 4 refused (write gate)
state: $PI_BOARD_STATE_DIR or ~/.pi-board/ (one directory per room)
env: PI_BOARD_AUTHOR (author of record) · PI_BOARD_ALIAS (peer alias, default "board")`;

export const COMMAND_USAGES: ReadonlyMap<string, string> = new Map<string, string>([
  ["join", JOIN_USAGE],
  ["write", WRITE_USAGE],
  ["read", READ_USAGE],
  ["grep", GREP_USAGE],
  ["watch", WATCH_USAGE],
]);

export function printGeneralUsage(): void {
  say(GENERAL_USAGE);
}

export function printCommandHelp(command: string): boolean {
  const usage = COMMAND_USAGES.get(command);
  if (usage === undefined) return false;
  say(usage);
  return true;
}
