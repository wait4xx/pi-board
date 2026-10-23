// src/extension/tools.ts — the board tools (board_write / board_read /
// board_grep / board_watch). Plain JSON Schema parameters
// (zero-dependency), honest statuses (a grep miss is an honest empty; a
// failed announcement never undoes the write), and promptGuidelines that
// teach the BEHAVIOR the papers measured value in: grep before retrying,
// FAIL is the highest-value entry, watch at the turn boundary.
import { checkWriteGate } from "../mesh/gates.js";
import { announceWrite, failSummaryLine, selectNewFails, type NotifiableEntry } from "../mesh/notify.js";
import {
  ENTRY_TYPES,
  defaultAuthor,
  entryLine,
  grepBoard,
  grepLine,
  isEntryType,
  readWindow,
  unfoldById,
  writeEntry,
  type BoardEntry,
  type EntryType,
} from "../entries/entries.js";
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
    text: { type: "string", description: "Summary line, ≤280 chars — must survive a turn boundary by being cheap to read." },
    detail: { type: "string", description: "Optional long form, ≤8 KiB — unfolded only by board_read { id }." },
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

function storeFor(runtime: BoardRuntime, room: unknown): ReturnType<BoardRuntime["getStore"]> {
  return runtime.getStore(typeof room === "string" && room !== "" ? room : undefined);
}

// ---- board_write ----

async function execBoardWrite(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const runtime = getRuntime();
  if (runtime === null) return textResult("board: session runtime not ready — retry");
  const roomParam = params.room;
  const room = typeof roomParam === "string" && roomParam !== "" ? roomParam : runtime.room;
  if (room === undefined) return badParams("board_write needs a room (pass room, set $PI_BOARD_ROOM, or run `piboard join <room>`)");

  const type = params.type;
  if (typeof type !== "string" || !isEntryType(type)) {
    return badParams(`board_write type must be one of ${ENTRY_TYPES.join(" | ")}`);
  }
  const text = params.text;
  if (typeof text !== "string" || text.trim() === "") return badParams("board_write needs a non-empty text");

  // the write gate runs BEFORE the kernel (DESIGN §5.2) — the session's
  // auto-joined role decides; an observer board writes nothing
  const gate = checkWriteGate({ observer: runtime.observer, room });
  if (!gate.ok) return textResult(`${gate.reason} — ${gate.detail}`);

  const store = runtime.getStore(room);
  let entry: BoardEntry;
  try {
    entry = writeEntry(store, {
      type,
      room,
      text,
      ...(typeof params.detail === "string" && params.detail !== "" ? { detail: params.detail } : {}),
      ...(typeof params.ref === "string" && params.ref !== "" ? { ref: params.ref } : {}),
      ...(typeof params.leaseRef === "string" && params.leaseRef !== "" ? { leaseRef: params.leaseRef } : {}),
      author: defaultAuthor(),
    });
  } catch (err) {
    return textResult(`error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const lines = [entryLine(entry)];
  // announce after persist — a failed announce never undoes the write
  if (runtime.peer !== null && runtime.peer.room === room && !runtime.observer) {
    try {
      const notifiable: NotifiableEntry = { id: entry.id, type: entry.type, room, short: entry.text, at: entry.at };
      const res = await announceWrite(runtime.peer, notifiable);
      if (!res.ok) lines.push(`announcement not delivered (${res.status}${res.reason !== undefined ? `: ${res.reason}` : ""}) — entry ${entry.id} is persisted`);
    } catch (err) {
      lines.push(`announcement failed (${err instanceof Error ? err.message : String(err)}) — entry ${entry.id} is persisted`);
    }
  } else if (runtime.peer === null) {
    lines.push(`store-only write (no peer): ${runtime.peerStatus}`);
  }
  return textResult(lines.join("\n"));
}

// ---- board_read ----

function execBoardRead(getRuntime: GetRuntime, params: Record<string, unknown>): ToolResult {
  const runtime = getRuntime();
  if (runtime === null) return textResult("board: session runtime not ready — retry");
  const store = storeFor(runtime, params.room);

  const id = params.id;
  if (typeof id === "string" && id !== "") {
    const entry = unfoldById(store, id);
    if (entry === undefined) return textResult(`not_found: no such entry ${id}`);
    const lines = [`${entry.id} ${entry.type} ${entry.author} ${entry.at}`, entry.text];
    if (typeof entry.detail === "string") lines.push("--- detail ---", entry.detail);
    if (typeof entry.ref === "string") lines.push(`ref: ${entry.ref}`);
    if (typeof entry.leaseRef === "string") lines.push(`lease: ${entry.leaseRef}`);
    return textResult(lines.join("\n"));
  }

  let limit = store.limits.readWindowDefault;
  if (typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0) {
    limit = Math.min(params.limit, store.limits.readWindowMax);
  }
  const entries = readWindow(store, limit);
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
  const store = storeFor(runtime, params.room);
  try {
    const rows = grepBoard(store, query, {
      ...(typeParam !== undefined ? { type: typeParam as EntryType } : {}),
      ...(typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0 ? { limit: params.limit } : {}),
    });
    // a miss is an honest empty — never an error, never invented rows
    return textResult(rows.length === 0 ? "(no match)" : rows.map(grepLine).join("\n"));
  } catch (err) {
    return textResult(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- board_watch ----

function execBoardWatch(getRuntime: GetRuntime, params: Record<string, unknown>): ToolResult {
  const runtime = getRuntime();
  if (runtime === null) return textResult("board: session runtime not ready — retry");
  const store = storeFor(runtime, params.room);
  const notifiable: NotifiableEntry[] = (readWindow(store, store.limits.readWindowMax) as BoardEntry[]).map((e) => ({
    id: e.id,
    type: e.type,
    room: e.room,
    short: e.text,
    at: e.at,
  }));
  const line = failSummaryLine(selectNewFails(notifiable, 0)); // full visible history: the tool digests ALL FAILs, caller decides
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
      "budget on it. Keep text ≤280 chars (one skimmable line); put the long story in detail (read via board_read { id }). " +
      "Pair a CLAIM with the mesh_claim lease id in leaseRef — the board informs, the lease enforces.",
    parameters: BOARD_WRITE_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => execBoardWrite(getRuntime, params),
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
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => Promise.resolve(execBoardRead(getRuntime, params)),
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
      "that dead end. A '(in detail)' marker means the match is in the long form: follow up with board_read { id }.",
    parameters: BOARD_GREP_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => Promise.resolve(execBoardGrep(getRuntime, params)),
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
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => Promise.resolve(execBoardWatch(getRuntime, params)),
  });
}
