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
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { boardDir, BoardStore } from "../store/store.js";
import { TypedBoard } from "../entries/board.js";
import { ENTRY_TYPES, validateDraft, type EntryDraft } from "../entries/types.js";
import { checkWriteGate, gateRefusalText } from "../mesh/gates.js";
import { announceWrite, failSummaryLine, selectNewFails } from "../mesh/notify.js";
import { connectBoardPeer } from "../mesh/peer.js";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_REFUSED = 4;

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

/** Mirrors store.ts boardDir's root resolution (kept local: this module
 *  also needs the root itself for board.json). */
function stateRoot(): string {
  const override = process.env.PI_BOARD_STATE_DIR;
  return override !== undefined && override !== "" ? override : join(homedir(), ".pi-board");
}

function rolePath(): string {
  return join(stateRoot(), "board.json");
}

function readRole(): RoleConfig | undefined {
  try {
    const raw = JSON.parse(readFileSync(rolePath(), "utf8")) as Partial<RoleConfig>;
    if (typeof raw.room !== "string" || typeof raw.alias !== "string" || typeof raw.observer !== "boolean") {
      return undefined;
    }
    return { room: raw.room, alias: raw.alias, observer: raw.observer, watermarkMs: raw.watermarkMs ?? 0 };
  } catch {
    return undefined;
  }
}

function writeRole(role: RoleConfig): void {
  const target = rolePath();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(role, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function usage(out: NodeJS.WriteStream): void {
  out.write(
    [
      "usage: piboard <command> [args]",
      "",
      "  piboard join <room> [--observer] [--alias NAME]   become the room's board presence",
      "  piboard watch                                      print new-FAIL boundary lines (local)",
      "  piboard write --type T --text \"…\" [--detail-file -|PATH] [--ref R]",
      "  piboard read [--id ID] [--limit N]                 newest window, or one entry unfolded",
      "  piboard grep \"a,b&c\"                                boolean search (, = OR, & = AND)",
      "",
      `types: ${ENTRY_TYPES.join(" | ")}`,
    ].join("\n") + "\n",
  );
}

/** Parse --flag value pairs; flags without values are booleans. */
function parseFlags(args: string[]): { flags: Map<string, string | boolean>; positional: string[] } {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i += 1;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function readDetailFile(value: string | boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") usageError("--detail-file needs a path (or - for stdin)");
  if (value === "-") return readFileSync(process.stdin.fd, "utf8");
  return readFileSync(value, "utf8");
}

function usageError(message: string): never {
  process.stderr.write(`piboard: ${message}\n`);
  usage(process.stderr);
  process.exit(EXIT_USAGE);
}

async function cmdJoin(positional: string[], flags: Map<string, string | boolean>): Promise<number> {
  const room = positional[0];
  if (room === undefined || room === "") usageError("join needs a room: piboard join <room> [--observer]");
  const aliasOverride = flags.get("alias");
  const alias = typeof aliasOverride === "string" && aliasOverride !== "" ? aliasOverride : process.env.PI_BOARD_ALIAS ?? "board";
  const observer = flags.get("observer") === true;

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
  const resuming = previous !== undefined;
  const watermarkMs = resuming ? previous.watermarkMs : Date.now();
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
  const role = readRole();
  if (role === undefined) {
    process.stderr.write("piboard: not joined — run `piboard join <room>` first (watch reads the joined room's board)\n");
    return EXIT_ERROR;
  }
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

async function cmdWrite(flags: Map<string, string | boolean>): Promise<number> {
  const role = readRole();
  if (role === undefined) {
    process.stderr.write("piboard: not joined — run `piboard join <room>` first (writes need a role)\n");
    return EXIT_ERROR;
  }
  const gate = checkWriteGate({ observer: role.observer, room: role.room });
  if (!gate.ok) {
    process.stderr.write(`piboard: write refused (${gate.reason}): ${gateRefusalText(gate)}\n`);
    return EXIT_REFUSED;
  }
  const type = flags.get("type");
  const text = flags.get("text");
  if (typeof type !== "string" || typeof text !== "string" || text === "") {
    usageError("write needs --type and --text");
  }
  const detail = readDetailFile(flags.get("detail-file"));
  const ref = flags.get("ref");
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
    });
  } catch (err) {
    // validation is a usage problem (closed type set, shapes), not a crash
    usageError(err instanceof Error ? err.message : "invalid entry");
  }
  const entry = board.write(draft as unknown as Record<string, unknown>);
  process.stdout.write(`${entry.id} ${entry.type} ${entry.text}\n`);
  process.stdout.write(`(announced by the board presence — run \`piboard join\` if nothing is announcing)\n`);
  return EXIT_OK;
}

async function cmdRead(flags: Map<string, string | boolean>): Promise<number> {
  const role = readRole();
  if (role === undefined) {
    process.stderr.write("piboard: not joined — run `piboard join <room>` first\n");
    return EXIT_ERROR;
  }
  const board = TypedBoard.open(role.room);
  const id = flags.get("id");
  if (typeof id === "string" && id !== "") {
    const entry = board.readById(id);
    if (entry === undefined) {
      process.stderr.write(`piboard: no entry ${id} on this board\n`);
      return EXIT_NOT_FOUND;
    }
    process.stdout.write(`${entry.id} ${entry.type} ${entry.at} ${entry.author}: ${entry.text}\n`);
    if (entry.detail !== undefined) process.stdout.write(`${entry.detail}\n`);
    return EXIT_OK;
  }
  const limitFlag = flags.get("limit");
  if (limitFlag !== undefined && (typeof limitFlag !== "string" || !/^\d+$/.test(limitFlag))) {
    usageError("--limit needs a positive integer");
  }
  const limit = typeof limitFlag === "string" ? Number.parseInt(limitFlag, 10) : undefined;
  for (const entry of board.read(limit)) {
    process.stdout.write(`${entry.id} ${entry.type} ${entry.at} ${entry.author}: ${entry.text}\n`);
  }
  return EXIT_OK;
}

async function cmdGrep(positional: string[]): Promise<number> {
  // Usage validation before state checks: a malformed invocation is a
  // usage error whether or not a board has joined.
  const query = positional[0];
  if (query === undefined || query === "") usageError("grep needs a query: piboard grep \"a,b&c\"");
  const role = readRole();
  if (role === undefined) {
    process.stderr.write("piboard: not joined — run `piboard join <room>` first\n");
    return EXIT_ERROR;
  }
  const board = TypedBoard.open(role.room);
  let rows;
  try {
    rows = board.grep(query);
  } catch (err) {
    usageError(err instanceof Error ? err.message : "invalid query");
  }
  for (const { entry, matchedInDetail } of rows) {
    process.stdout.write(`${entry.id} ${entry.type}${matchedInDetail ? " (in detail)" : ""} ${entry.text}\n`);
  }
  return EXIT_OK;
}

/** The command dispatcher. Returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  const { flags, positional } = parseFlags(rest);
  switch (command) {
    case "join":
      return cmdJoin(positional, flags);
    case "watch":
      return cmdWatch();
    case "write":
      return cmdWrite(flags);
    case "read":
      return cmdRead(flags);
    case "grep":
      return cmdGrep(positional);
    case undefined:
    case "--help":
    case "help":
      usage(process.stdout);
      return command === undefined ? EXIT_USAGE : EXIT_OK;
    default:
      usageError(`unknown command: ${command}`);
  }
}
