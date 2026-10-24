/**
 * src/cli/main.ts — the piboard command surface (DESIGN §6): five
 * subcommands, one verb each, honest exit codes.
 *
 * Process model: `join` is the board's PRESENCE — it owns the peer
 * connection and is the only process that announces (a CLI write connecting
 * under the same alias would collide with it; instead the daemon polls the
 * local store and broadcasts entries newer than its persisted watermark).
 * `write`/`read`/`grep` are one-shot local operations; `watch` is a local
 * viewer printing the turn-boundary FAIL summary line.
 *
 * Exit codes: 0 ok · 1 error · 2 usage · 3 not_found (read --id) ·
 * 4 refused (observer / non-member write attempt).
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardDir, BoardStore, stateRoot } from "../store/store.js";
import { TypedBoard } from "../entries/board.js";
import { ENTRY_TYPES, isEntryType, validateDraft, type EntryDraft } from "../entries/types.js";
import { loadLimits } from "../shared/limits.js";
import { checkWriteGate, gateRefusalText } from "../mesh/gates.js";
import { announceWrite, failSummaryLine, selectNewFails } from "../mesh/notify.js";
import { connectBoardPeer } from "../mesh/peer.js";
import { parseArgs, specUsage, type ArgSpec, type ParsedArgs } from "./args.js";
import { EXIT_ERROR, EXIT_NOT_FOUND, EXIT_OK, EXIT_REFUSED, EXIT_USAGE } from "./codes.js";

/** Poll pace for the join daemon's announce loop and watch's boundary. */
const ANNOUNCE_POLL_MS = 1_000;
const WATCH_POLL_MS = 500;

interface RoleConfig {
  room: string;
  alias: string;
  observer: boolean;
  /** ISO ms of the newest entry this board presence has announced. */
  watermarkMs: number;
}

function rolePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateRoot(env), "board.json");
}

/** The joined-role read, honestly three-stated: a config that EXISTS but
 *  cannot be trusted is NOT "not joined" — reporting it as such would send
 *  the operator to re-join when the real fix is repairing the file. */
export type RoleRead =
  | { state: "absent" }
  | { state: "valid"; role: RoleConfig }
  | { state: "corrupt"; path: string; problem: string };

export function readRole(env: NodeJS.ProcessEnv = process.env): RoleRead {
  const path = rolePath(env);
  if (!existsSync(path)) return { state: "absent" };
  let raw: Partial<RoleConfig>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RoleConfig>;
  } catch (err) {
    return { state: "corrupt", path, problem: err instanceof Error ? err.message : "not valid JSON" };
  }
  if (typeof raw.room !== "string" || raw.room === "" || typeof raw.alias !== "string" || typeof raw.observer !== "boolean") {
    return { state: "corrupt", path, problem: "room/alias/observer missing or wrong-typed" };
  }
  return { state: "valid", role: { room: raw.room, alias: raw.alias, observer: raw.observer, watermarkMs: raw.watermarkMs ?? 0 } };
}

/** Shared handling: corrupt → usage error naming the path; absent → the
 *  caller's not-joined wording. */
function requireRole(notJoinedWording: string): { ok: true; role: RoleConfig } | { ok: false; code: number } {
  const read = readRole();
  if (read.state === "valid") return { ok: true, role: read.role };
  if (read.state === "corrupt") {
    process.stderr.write(`piboard: board config unreadable (${read.path}): ${read.problem} — fix or remove it\n`);
    return { ok: false, code: EXIT_USAGE };
  }
  process.stderr.write(`piboard: ${notJoinedWording}\n`);
  return { ok: false, code: EXIT_ERROR };
}

/**
 * Room resolution for the read-only commands: --room flag >
 * $PI_BOARD_ROOM > the joined config. A room that does not come from the
 * joined config is a STORE-ONLY operation — reads need no role and touch
 * no gate; writes keep their join requirement (the role gate's premise,
 * DESIGN §6 erratum). A corrupt config errors even with --room: an
 * untrustworthy config must never be silently bypassed.
 */
function resolveReadRoom(values: Map<string, string>): { ok: true; room: string } | { ok: false; code: number } {
  const read = readRole();
  if (read.state === "corrupt") {
    process.stderr.write(`piboard: board config unreadable (${read.path}): ${read.problem} — fix or remove it\n`);
    return { ok: false, code: EXIT_USAGE };
  }
  const fromFlag = values.get("room");
  if (fromFlag !== undefined && fromFlag !== "") return { ok: true, room: fromFlag };
  const fromEnv = process.env.PI_BOARD_ROOM;
  if (fromEnv !== undefined && fromEnv !== "") return { ok: true, room: fromEnv };
  if (read.state === "valid") return { ok: true, room: read.role.room };
  process.stderr.write("piboard: no room — use --room, set $PI_BOARD_ROOM, or run `piboard join <room>` first\n");
  return { ok: false, code: EXIT_ERROR };
}

function writeRole(role: RoleConfig): void {
  const target = rolePath();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(role, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- usage surface (SPECS-driven; the parser lives in args.ts) ----

const JOIN_SPECS: ArgSpec[] = [
  { name: "observer", kind: "flag", help: "join read-only (writes refused)" },
  { name: "alias", kind: "value", meta: "A", help: 'peer alias (default $PI_BOARD_ALIAS or "board")' },
];
const WRITE_SPECS: ArgSpec[] = [
  { name: "type", kind: "value", meta: "T", help: `one of ${ENTRY_TYPES.join(" | ")}` },
  { name: "text", kind: "value", meta: "TXT", help: "summary line (≤280 bytes)" },
  { name: "detail-file", kind: "value", meta: "PATH", help: "long form file, or - for stdin (≤8 KiB, bounded read)" },
  { name: "ref", kind: "value", meta: "R", help: "git-reachable anchor (path, commit, URL)" },
  { name: "lease-ref", kind: "value", meta: "L", help: "mesh_claim lease id (annotation only)" },
];
const READ_SPECS: ArgSpec[] = [
  { name: "id", kind: "value", meta: "ID", help: "unfold this entry's detail" },
  { name: "limit", kind: "value", meta: "N", help: "window size (capped by the configured max)" },
  { name: "room", kind: "value", meta: "ROOM", help: "read this room's board without a joined role (store-only)" },
];
const GREP_SPECS: ArgSpec[] = [
  { name: "type", kind: "value", meta: "T", help: "filter by entry type" },
  { name: "limit", kind: "value", meta: "N", help: `max rows (default ${loadLimits().grepLimitDefault}, env-tunable)` },
  { name: "room", kind: "value", meta: "ROOM", help: "search this room's board without a joined role (store-only)" },
];
const WATCH_SPECS: ArgSpec[] = [];

interface CommandEntry {
  usage: string;
  specs: ArgSpec[];
  run: (parsed: ParsedArgs) => Promise<number>;
}

const COMMANDS = new Map<string, CommandEntry>([
  ["join", { usage: "usage: piboard join <room> [--observer] [--alias A]", specs: JOIN_SPECS, run: (p) => cmdJoin(p) }],
  ["write", { usage: 'usage: piboard write --type T --text "…" [--detail-file -|PATH] [--ref R] [--lease-ref L]', specs: WRITE_SPECS, run: (p) => cmdWrite(p) }],
  ["read", { usage: "usage: piboard read [--id ID] [--limit N] [--room ROOM]", specs: READ_SPECS, run: (p) => cmdRead(p) }],
  ["grep", { usage: 'usage: piboard grep "a,b&c" [--type T] [--limit N]  (, = OR, & = AND, ci)', specs: GREP_SPECS, run: (p) => cmdGrep(p) }],
  ["watch", { usage: "usage: piboard watch  (prints new FAIL lines at each boundary until stopped)", specs: WATCH_SPECS, run: () => cmdWatch() }],
]);

const GENERAL_USAGE = `piboard — shared context board for pi-mesh (v0.1)

usage: piboard <command> [options]

commands:
  join <room> [--observer] [--alias A]      become the room's board presence (announces writes)
  write --type T --text "…" [options]       append a typed entry (needs a joined role)
  read [--id ID] [--limit N]                newest window, or unfold one entry's detail
  grep "a,b&c" [--type T] [--limit N]       boolean search (, = OR, & = AND, ci)
  watch                                     print new FAIL lines as they land (local)
  help [cmd]                                this help, or one command's options

entry types: ${ENTRY_TYPES.join(" | ")}
exit codes: 0 ok · 1 error · 2 usage · 3 not_found (read --id) · 4 refused (write gate)
state: $PI_BOARD_STATE_DIR or ~/.pi-board/ (one directory per room)
env: PI_BOARD_ALIAS (peer alias, default "board")`;

function printGeneralUsage(): void {
  process.stdout.write(`${GENERAL_USAGE}\n`);
}

function printCommandHelp(command: string): boolean {
  const entry = COMMANDS.get(command);
  if (entry === undefined) return false;
  const options = entry.specs
    .map((s) => `  --${s.name}${s.kind === "value" ? ` ${s.meta ?? s.name.toUpperCase()}` : ""}   ${s.help ?? ""}`)
    .join("\n");
  process.stdout.write(`${entry.usage}\n${options === "" ? "" : `${options}\n`}\n`);
  return true;
}

function commandUsageError(command: string, reason: string): number {
  const entry = COMMANDS.get(command);
  process.stderr.write(`piboard: ${reason}\n`);
  process.stderr.write(`${entry?.usage ?? ""}\n`);
  return EXIT_USAGE;
}

function readDetailFile(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // An interactive terminal has nothing to pipe: reading it would HANG the
  // command waiting for input nobody will type — refuse with the fix.
  const guard = stdinDetailGuard(process.stdin.isTTY === true);
  if (value === "-" && guard !== undefined) {
    process.stderr.write(`piboard: ${guard}\n`);
    process.exit(EXIT_USAGE);
  }
  // Bounded read: the byte bound must apply at INGESTION, never after the
  // whole stream has been loaded (DESIGN: never an unbounded blob).
  const maxBytes = loadLimits().maxDetailChars;
  const fd = value === "-" ? 0 : openSync(value, "r");
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    // stdin is a pipe: an explicit position forces a seek and throws
    // ESPIPE — read from the current position there, from 0 on files.
    const n = readSync(fd, buf, 0, maxBytes + 1, value === "-" ? null : 0);
    if (n > maxBytes) {
      process.stderr.write(`piboard: --detail-file exceeds the ${maxBytes}-byte bound — refusing (nothing was read past it)\n`);
      process.exit(EXIT_ERROR);
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    if (fd !== 0) closeSync(fd);
  }
}

/** Extracted for a unit test: the refusal line for interactive stdin. */
export function stdinDetailGuard(isTty: boolean): string | undefined {
  return isTty ? "--detail-file - refuses an interactive terminal — pipe the content or pass a file path" : undefined;
}

async function cmdJoin(parsed: ParsedArgs): Promise<number> {
  const room = parsed.positionals[0];
  if (room === undefined || room === "") return commandUsageError("join", "join needs a room");
  const aliasOverride = parsed.values.get("alias");
  const alias = aliasOverride !== undefined && aliasOverride !== "" ? aliasOverride : process.env.PI_BOARD_ALIAS ?? "board";
  const observer = parsed.flags.has("observer");

  const peer = await connectBoardPeer({
    room,
    alias,
    observer,
  });
  // Resume, never replay: a restarted presence reuses its persisted
  // watermark so entries announced before the restart are not re-broadcast;
  // a FRESH join starts at now and announces nothing that already exists.
  // Either way the operator sees the honest count of skipped entries.
  const previous = readRole();
  if (previous.state === "corrupt") {
    process.stderr.write(`piboard: board config unreadable (${previous.path}): ${previous.problem} — fix or remove it\n`);
    return EXIT_USAGE;
  }
  const resuming = previous.state === "valid";
  const watermarkMs = resuming ? previous.role.watermarkMs : Date.now();
  const role: RoleConfig = { room, alias, observer, watermarkMs };
  writeRole(role);
  const store = new BoardStore(boardDir(room));
  const skipped = store.read().filter((entry) => Date.parse(entry.at) <= watermarkMs).length;
  process.stdout.write(
    `joined ${room} as ${peer.alias} (${observer ? "observer" : "member"}); ` +
      `${resuming ? `resuming from ${new Date(watermarkMs).toISOString()}` : "fresh join (existing entries are not replayed)"}, ` +
      `skipping ${skipped}${skipped >= 2000 ? "+" : ""} already-covered entries\n`,
  );

  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    const fresh = store.read(50).filter((entry) => Date.parse(entry.at) > role.watermarkMs);
    for (const entry of fresh.reverse()) {
      // oldest first: the room reads the board's history in order
      let announced = false;
      try {
        const result = await announceWrite(peer, {
          id: entry.id,
          type: entry.type as "OBSERVED" | "FACT" | "FAIL" | "CLAIM" | "PATCH_SUMMARY",
          room,
          short: typeof entry.text === "string" ? entry.text : "",
          at: entry.at,
        });
        announced = result.ok;
        process.stdout.write(
          `announced ${entry.id} ${entry.type}${result.ok ? "" : ` (announce ${result.status}: ${result.reason ?? "?"})`}\n`,
        );
      } catch (err) {
        // a throwing send must not kill the presence loop — retry next poll
        process.stdout.write(`announced ${entry.id} ${entry.type} (announce error: ${err instanceof Error ? err.message : String(err)})\n`);
      }
      if (!announced) {
        // do NOT advance past a failed entry: the watermark may only move
        // over entries the room actually received — retry on the next poll
        break;
      }
      role.watermarkMs = Date.parse(entry.at);
      writeRole(role);
    }
    await sleep(ANNOUNCE_POLL_MS);
  }
  await peer.close();
  return EXIT_OK;
}

async function cmdWatch(): Promise<number> {
  const got = requireRole("not joined — run `piboard join <room>` first (watch reads the joined room's board)");
  if (!got.ok) return got.code;
  const role = got.role;
  const store = new BoardStore(boardDir(role.room));
  let boundary = Date.now();
  process.stdout.write(`watching ${role.room} for new FAIL entries\n`);
  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (running) {
    await sleep(WATCH_POLL_MS);
    const entries = store.read(500).map((entry) => ({
      id: entry.id,
      type: entry.type as "OBSERVED" | "FACT" | "FAIL" | "CLAIM" | "PATCH_SUMMARY",
      room: role.room,
      short: typeof entry.text === "string" ? entry.text : "",
      at: entry.at,
    }));
    const line = failSummaryLine(selectNewFails(entries, boundary));
    if (line !== "") {
      process.stdout.write(`${line}\n`);
      boundary = Date.now();
    }
  }
  return EXIT_OK;
}

async function cmdWrite(parsed: ParsedArgs): Promise<number> {
  if (parsed.positionals.length > 0) return commandUsageError("write", "write takes no positional arguments");
  // Usage validation precedes state checks everywhere: a malformed
  // invocation is a usage error whether or not a board has joined, and
  // whether or not the role would refuse the write.
  const type = parsed.values.get("type");
  const text = parsed.values.get("text");
  if (type === undefined || text === undefined || text === "") {
    return commandUsageError("write", "write needs --type and --text");
  }
  if (!isEntryType(type)) {
    return commandUsageError("write", `--type must be one of ${ENTRY_TYPES.join("|")}, got: ${type}`);
  }
  const got = requireRole("not joined — run `piboard join <room>` first (writes need a role)");
  if (!got.ok) return got.code;
  const role = got.role;
  const gate = checkWriteGate({ observer: role.observer, room: role.room });
  if (!gate.ok) {
    process.stderr.write(`piboard: write refused (${gate.reason}): ${gateRefusalText(gate)}\n`);
    return EXIT_REFUSED;
  }
  const detail = readDetailFile(parsed.values.get("detail-file"));
  const ref = parsed.values.get("ref");
  const leaseRef = parsed.values.get("lease-ref");
  const board = TypedBoard.open(role.room);
  let draft: EntryDraft;
  try {
    // The closed-set check happens inside validateDraft; the CLI only
    // guarantees stringhood at this point.
    draft = validateDraft({
      type: type as EntryDraft["type"],
      author: role.alias,
      room: role.room,
      text,
      ...(detail !== undefined ? { detail } : {}),
      ...(typeof ref === "string" ? { ref } : {}),
      ...(typeof leaseRef === "string" && leaseRef !== "" ? { leaseRef } : {}),
    });
  } catch (err) {
    // validation is a usage problem (closed type set, shapes), not a crash
    return commandUsageError("write", err instanceof Error ? err.message : "invalid entry");
  }
  const entry = board.write(draft as unknown as Record<string, unknown>);
  process.stdout.write(`${entry.id} ${entry.type} ${entry.text}\n`);
  process.stdout.write(`(announced by the board presence — run \`piboard join\` if nothing is announcing)\n`);
  return EXIT_OK;
}

async function cmdRead(parsed: ParsedArgs): Promise<number> {
  if (parsed.positionals.length > 0) return commandUsageError("read", "read takes no positional arguments");
  const room = resolveReadRoom(parsed.values);
  if (!room.ok) return room.code;
  const board = TypedBoard.open(room.room);
  const id = parsed.values.get("id");
  if (id !== undefined && id !== "") {
    const entry = board.readById(id);
    if (entry === undefined) {
      process.stderr.write(`piboard: no entry ${id} on this board\n`);
      return EXIT_NOT_FOUND;
    }
    process.stdout.write(`${entry.id} ${entry.type} ${entry.at} ${entry.author}: ${entry.text}\n`);
    if (entry.detail !== undefined) process.stdout.write(`${entry.detail}\n`);
    return EXIT_OK;
  }
  const limitFlag = parsed.values.get("limit");
  if (limitFlag !== undefined && !/^\d+$/.test(limitFlag)) {
    return commandUsageError("read", "--limit needs a positive integer");
  }
  const limit = limitFlag !== undefined ? Number.parseInt(limitFlag, 10) : undefined;
  for (const entry of board.read(limit)) {
    process.stdout.write(`${entry.id} ${entry.type} ${entry.at} ${entry.author}: ${entry.text}\n`);
  }
  return EXIT_OK;
}

async function cmdGrep(parsed: ParsedArgs): Promise<number> {
  if (parsed.positionals.length > 1) return commandUsageError("grep", "grep takes exactly one query argument");
  // Usage validation before state checks: a malformed invocation is a
  // usage error whether or not a board has joined.
  const query = parsed.positionals[0];
  if (query === undefined || query === "") return commandUsageError("grep", 'grep needs a query: piboard grep "a,b&c"');
  const typeFlag = parsed.values.get("type");
  if (typeFlag !== undefined && !isEntryType(typeFlag)) {
    return commandUsageError("grep", `--type must be one of ${ENTRY_TYPES.join("|")}, got: ${typeFlag}`);
  }
  const limitFlag = parsed.values.get("limit");
  if (limitFlag !== undefined && (!/^\d+$/.test(limitFlag) || Number.parseInt(limitFlag, 10) <= 0)) {
    return commandUsageError("grep", "--limit needs a positive integer");
  }
  const limit = limitFlag !== undefined ? Number.parseInt(limitFlag, 10) : undefined;
  const room = resolveReadRoom(parsed.values);
  if (!room.ok) return room.code;
  const board = TypedBoard.open(room.room);
  let rows;
  try {
    rows = board.grep(query, {
      ...(limit !== undefined ? { limit } : {}),
      ...(typeof typeFlag === "string" ? { type: typeFlag } : {}),
    });
  } catch (err) {
    return commandUsageError("grep", err instanceof Error ? err.message : "invalid query");
  }
  for (const { entry, matchedInDetail } of rows) {
    process.stdout.write(`${entry.id} ${entry.type}${matchedInDetail ? " (in detail)" : ""} ${entry.text}\n`);
  }
  return EXIT_OK;
}

/** The command dispatcher. Returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "") {
    printGeneralUsage();
    return EXIT_USAGE;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    const topic = argv[1];
    if (topic === undefined) {
      printGeneralUsage();
      return EXIT_OK;
    }
    if (printCommandHelp(topic)) return EXIT_OK;
    process.stderr.write(`piboard: no such command: ${topic}\n`);
    printGeneralUsage();
    return EXIT_USAGE;
  }

  const entry = COMMANDS.get(command);
  if (entry === undefined) {
    process.stderr.write(`piboard: unknown command "${command}"\n`);
    printGeneralUsage();
    return EXIT_USAGE;
  }
  const res = parseArgs(argv.slice(1), entry.specs);
  if (!res.ok) return commandUsageError(command, res.error);
  if (res.help) {
    process.stdout.write(`${entry.usage} ${specUsage(entry.specs)}\n`);
    printCommandHelp(command);
    return EXIT_OK;
  }
  return entry.run(res.parsed);
}
