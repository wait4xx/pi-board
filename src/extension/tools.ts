// src/extension/tools.ts — the board tools (board_write / board_read /
// board_grep / board_watch), ported from the native proposal and adapted
// to the watermark-daemon architecture: board_write NEVER announces —
// the room's join daemon owns every broadcast (DESIGN §5.3); the tool
// appends to the store the daemon polls. Plain JSON Schema parameters
// (zero-dependency), honest statuses (a grep miss is an honest empty),
// and promptGuidelines that teach the high-value behavior: grep before
// retrying, FAIL is the highest-value entry, watch at the turn boundary.
import { checkWriteGate } from "../mesh/gates.js";
import { failSummaryLine, selectNewFails, type NotifiableEntry } from "../mesh/notify.js";
import { ENTRY_TYPES, isEntryType, type Entry, type EntryType } from "../entries/types.js";
import { TypedBoard } from "../entries/board.js";
import type { BoardRuntime } from "./runtime.js";
import type { ExtensionAPI, ToolResult } from "./pi-types.js";
import { textResult } from "./pi-types.js";

export type GetRuntime = () => BoardRuntime | null;

const ROOM_PARAM = {
  type: "string",
  description: "Board room; defaults to the session's auto-joined room ($PI_BOARD_ROOM or `piboard join`).",
};

const ENTRY_TYPE_ENUM = [...ENTRY_TYPES];

const BOARD_WRITE_PARAMETERS = {
  type: "object",
  properties: {
    type: { type: "string", enum: ENTRY_TYPE_ENUM, description: "OBSERVED (seen) | FACT (verified) | FAIL (falsified path) | CLAIM (informational ownership) | PATCH_SUMMARY (what a landed change did)" },
    text: { type: "string", description: "Summary line — must survive a turn boundary by being cheap to read." },
    detail: { type: "string", description: "Optional long form — unfolded only by board_read { id }." },
    ref: { type: "string", description: "Optional git-reachable anchor (path, commit, URL)." },
    leaseRef: { type: "string", description: "Optional mesh_claim lease id — annotation only; enforcement never lives here." },
    room: ROOM_PARAM,
  },
  required: ["type", "text"],
} as const;

const BOARD_READ_PARAMETERS = {
  type: "object",
  properties: {
    id: { type: "string", description: "Unfold this entry's detail (the only path detail takes to a reader)." },
    limit: { type: "number", description: "Window size (newest first), capped." },
    room: ROOM_PARAM,
  },
} as const;

const BOARD_GREP_PARAMETERS = {
  type: "object",
  properties: {
    query: { type: "string", description: "Boolean search: ',' = OR, '&' = AND (AND binds tighter), case-insensitive; matches text AND detail." },
    type: { type: "string", enum: ENTRY_TYPE_ENUM, description: "Filter by entry type." },
    limit: { type: "number", description: "Max rows." },
    room: ROOM_PARAM,
  },
  required: ["query"],
} as const;

const BOARD_WATCH_PARAMETERS = {
  type: "object",
  properties: { room: ROOM_PARAM },
} as const;

function badParams(message: string): ToolResult {
  return textResult(`usage: ${message}`);
}

function boardFor(runtime: BoardRuntime, room: unknown): TypedBoard {
  const target = typeof room === "string" && room !== "" ? room : undefined;
  return new TypedBoard(runtime.getStore(target));
}

function entryLine(entry: Entry): string {
  return `${entry.id} ${entry.type} ${entry.at} ${entry.author}: ${entry.text}`;
}

// ---- board_write ----

function execBoardWrite(getRuntime: GetRuntime, params: Record<string, unknown>): ToolResult {
  const runtime = getRuntime();
  if (runtime === null) return textResult("board: session runtime not ready — retry");
  const roomParam = params.room;
  const room = typeof roomParam === "string" && roomParam !== "" ? roomParam : runtime.room;
  if (room === undefined) {
    return badParams("board_write needs a room (pass room, set $PI_BOARD_ROOM, or run `piboard join <room>`)");
  }

  const type = params.type;
  if (typeof type !== "string" || !isEntryType(type)) {
    return badParams(`board_write type must be one of ${ENTRY_TYPES.join(" | ")}`);
  }
  const text = params.text;
  if (typeof text !== "string" || text.trim() === "") return badParams("board_write needs a non-empty text");

  // the write gate runs BEFORE the kernel (DESIGN §5.2) — the session's
  // auto-joined role decides; an observer session writes nothing
  const gate = checkWriteGate({ observer: runtime.observer, room });
  if (!gate.ok) return textResult(`${gate.reason} — ${gate.detail}`);

  const board = boardFor(runtime, room);
  let entry: Entry;
  try {
    entry = board.write({
      type,
      room,
      text,
      ...(typeof params.detail === "string" && params.detail !== "" ? { detail: params.detail } : {}),
      ...(typeof params.ref === "string" && params.ref !== "" ? { ref: params.ref } : {}),
      ...(typeof params.leaseRef === "string" && params.leaseRef !== "" ? { leaseRef: params.leaseRef } : {}),
      author: runtime.aliasBase,
    });
  } catch (err) {
    return textResult(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  // writer-announces is deliberately NOT here (v0.2 ruling): the room's
  // join daemon owns every broadcast — this write is announced when the
  // daemon's watermark poll sees it, exactly like a CLI write.
  return textResult(`${entryLine(entry)}\npersisted — the room's board presence (piboard join) announces it`);
}

// ---- board_read ----

function execBoardRead(getRuntime: GetRuntime, params: Record<string, unknown>): ToolResult {
  const runtime = getRuntime();
  if (runtime === null) return textResult("board: session runtime not ready — retry");
  const board = boardFor(runtime, params.room);

  const id = params.id;
  if (typeof id === "string" && id !== "") {
    const entry = board.readById(id);
    if (entry === undefined) return textResult(`not_found: no such entry ${id}`);
    const lines = [`${entry.id} ${entry.type} ${entry.author} ${entry.at}`, entry.text];
    if (typeof entry.detail === "string") lines.push("--- detail ---", entry.detail);
    if (typeof entry.ref === "string") lines.push(`ref: ${entry.ref}`);
    if (typeof entry.leaseRef === "string") lines.push(`lease: ${entry.leaseRef}`);
    return textResult(lines.join("\n"));
  }

  let limit = board.store.limits.readWindowDefault;
  if (typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0) {
    limit = Math.min(params.limit, board.store.limits.readWindowMax);
  }
  const entries = board.read(limit);
  return textResult(entries.length === 0 ? "(board is empty for this room)" : entries.map(entryLine).join("\n"));
}

// ---- board_grep ----

function execBoardGrep(getRuntime: GetRuntime, params: Record<string, unknown>): ToolResult {
  const runtime = getRuntime();
  if (runtime === null) return textResult("board: session runtime not ready — retry");
  const query = params.query;
  if (typeof query !== "string" || query === "") return badParams("board_grep needs a query (',' = OR, '&' = AND)");
  const typeParam = params.type;
  if (typeParam !== undefined && (typeof typeParam !== "string" || !isEntryType(typeParam))) {
    return badParams(`board_grep type must be one of ${ENTRY_TYPES.join(" | ")}`);
  }
  const board = boardFor(runtime, params.room);
  try {
    const rows = board.grep(query, {
      ...(typeParam !== undefined ? { type: typeParam as EntryType } : {}),
      ...(typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0 ? { limit: params.limit } : {}),
    });
    // a miss is an honest empty — never an error, never invented rows;
    // a (in detail) marker points at the long form for board_read { id }
    return textResult(
      rows.length === 0
        ? "(no match)"
        : rows
            .map((r) => `${r.entry.id} ${r.entry.type}: ${r.entry.text}${r.matchedInDetail ? " (in detail)" : ""}`)
            .join("\n"),
    );
  } catch (err) {
    return textResult(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- board_watch ----

function execBoardWatch(getRuntime: GetRuntime, params: Record<string, unknown>): ToolResult {
  const runtime = getRuntime();
  if (runtime === null) return textResult("board: session runtime not ready — retry");
  const board = boardFor(runtime, params.room);
  const notifiable: NotifiableEntry[] = board.read(board.store.limits.readWindowMax).map((e) => ({
    id: e.id,
    type: e.type,
    short: e.text,
    at: e.at,
  }));
  // TOOL variant: newest-first — when the clip cuts, what falls off is
  // the OLDEST failure, not the fresh one a turn needs first (the CLI
  // boundary variant keeps selectNewFails' oldest-first contract).
  const line = failSummaryLine(selectNewFails(notifiable, 0).reverse());
  return textResult(line === "" ? "(no FAIL entries recorded)" : line);
}

// ---- registration ----

export function registerTools(pi: ExtensionAPI, getRuntime: GetRuntime): void {
  pi.registerTool({
    name: "board_write",
    label: "Board Write",
    description:
      "Append a typed entry to the shared context board (OBSERVED | FACT | FAIL | CLAIM | PATCH_SUMMARY). " +
      "The board is the room's durable, searchable team memory — entries outlive messages.",
    promptSnippet: "Record a finding/failure/claim on the shared board.",
    promptGuidelines:
      "FAIL is the highest-value entry: record every falsified approach immediately so peers stop re-burning " +
      "budget on it. Keep text one skimmable line; put the long story in detail (read via board_read { id }). " +
      "Pair a CLAIM with the mesh_claim lease id in leaseRef — the board informs, the lease enforces. " +
      "Writes announce through the room's board presence (piboard join), not this session.",
    parameters: BOARD_WRITE_PARAMETERS,
    execute: (_toolCallId, params) => execBoardWrite(getRuntime, params),
  });

  pi.registerTool({
    name: "board_read",
    label: "Board Read",
    description:
      "Read the board's recent window (newest first, one-line summaries), or unfold one entry's detail by id.",
    promptSnippet: "Read recent board entries, or unfold one entry.",
    promptGuidelines:
      "First action when picking up shared work: read the window to absorb what the room already knows. " +
      "Use { id } to unfold detail — it is the only path the long form takes.",
    parameters: BOARD_READ_PARAMETERS,
    execute: (_toolCallId, params) => execBoardRead(getRuntime, params),
  });

  pi.registerTool({
    name: "board_grep",
    label: "Board Grep",
    description:
      "Search the board's FULL recorded history (rotated segments included): ',' = OR, '&' = AND " +
      "(AND binds tighter), case-insensitive, over text and detail. A miss returns an honest empty.",
    promptSnippet: "Search board history before retrying an approach.",
    promptGuidelines:
      "BEFORE retrying an approach or asking a peer, grep the board — a FAIL hit saves the whole budget of " +
      "that dead end. A detail match deserves a follow-up board_read { id }.",
    parameters: BOARD_GREP_PARAMETERS,
    execute: (_toolCallId, params) => execBoardGrep(getRuntime, params),
  });

  pi.registerTool({
    name: "board_watch",
    label: "Board Watch",
    description:
      "The FAIL digest: every FAIL entry visible on the board, one skimmable line — the turn-boundary " +
      "summary (normal priority, never an urgent frame).",
    promptSnippet: "Skim the room's recorded failures.",
    promptGuidelines: "Call at the start of a turn alongside mesh checks to see what the room already falsified.",
    parameters: BOARD_WATCH_PARAMETERS,
    execute: (_toolCallId, params) => execBoardWatch(getRuntime, params),
  });
}
