// src/mesh/notify.ts — task_0007: one normal-priority broadcast per write
// + the watch turn-boundary FAIL summary line (DESIGN §5.3, constraint #5).
//
// The announcement is what a write COSTS the room: exactly ONE frame,
// normal priority (never urgent — a skimmable summary line at the turn
// boundary beats interrupting peers), type + id + short text only. The
// `detail` field never travels: frames are bounded, detail unfolds only
// via board_read --id.
import type { BoardPeer } from "./peer.js";
import { guardWrite } from "./gates.js";

/** The five entry types (closed set owned by the entries module,
 *  task_0004; duplicated here as a structural union so notify compiles
 *  against the shape it needs — the entries module is the validation
 *  authority, this is the wire-consumer view). */
export type BoardEntryType = "OBSERVED" | "FACT" | "FAIL" | "CLAIM" | "PATCH_SUMMARY";

/** What notify needs from a stored entry — deliberately structural so the
 *  entries module (task_0004) satisfies it without an import cycle. */
export interface NotifiableEntry {
  id: string;
  type: BoardEntryType;
  /** The room the entry belongs to — the announce line and the FAIL digest
   *  carry it so a peer in several rooms knows WHICH board spoke. */
  room: string;
  /** The bounded short text; `detail` is NOT part of this shape on purpose. */
  short: string;
  at?: string;
}

/** Broadcast body cap — the short text is already bounded upstream; this is
 *  the wire-side guarantee that one frame stays skimmable. */
export const BOARD_BROADCAST_MAX_CHARS = 500;
/** The FAIL summary line cap (watch renders it at the turn boundary). */
export const FAIL_SUMMARY_MAX_CHARS = 400;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The one-line body of a write announcement: `board[<room>] TYPE id: short`. */
export function broadcastBody(entry: NotifiableEntry): string {
  return clip(`board[${entry.room}] ${entry.type} ${entry.id}: ${entry.short}`, BOARD_BROADCAST_MAX_CHARS);
}

export type AnnounceResult =
  | { ok: true; status: "delivered" }
  | { ok: false; status: string; reason?: string };

/**
 * Announce a SUCCESSFUL write to the room: one normal-priority broadcast.
 * Called after the gate passed and the store appended — a failed
 * announcement never undoes the write; the honest send status is returned
 * so the CLI can report it (an empty room is peer_not_found, for example).
 * The write gate runs first anyway: an observer board announces nothing.
 */
export async function announceWrite(peer: BoardPeer, entry: NotifiableEntry): Promise<AnnounceResult> {
  const guarded = await guardWrite(peer, async () => {
    const res = await peer.client.send({
      room: peer.room,
      broadcast: true,
      message: broadcastBody(entry),
    });
    return res;
  });
  if (!guarded.ok) {
    return { ok: false, status: guarded.status, reason: guarded.reason };
  }
  const res = guarded.value as { status: string; reason?: string };
  if (res.status === "delivered") return { ok: true, status: "delivered" };
  return { ok: false, status: res.status, reason: res.reason };
}

/** FAIL entries newer than the boundary timestamp (ISO string or epoch ms),
 *  oldest first — the input list to the summary line. */
export function selectNewFails(entries: NotifiableEntry[], sinceMs: number): NotifiableEntry[] {
  return entries
    .filter((e) => e.type === "FAIL")
    .filter((e) => {
      const at = e.at !== undefined ? Date.parse(e.at) : NaN;
      return Number.isFinite(at) && at > sinceMs;
    })
    .sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));
}

/**
 * The turn-boundary line for watch: ONE skimmable line, `⚠ board[<room>]:
 * N new FAIL — <id>:<short> …`, or "" when there is nothing new (watch
 * prints nothing rather than an empty line). Never urgent priority — this
 * is the whole point of constraint #5.
 */
export function failSummaryLine(newFails: NotifiableEntry[]): string {
  if (newFails.length === 0) return "";
  const room = newFails[0]!.room;
  const items = newFails.map((e) => `${e.id}:${clip(e.short, 80)}`).join(" | ");
  return clip(`⚠ board[${room}]: ${newFails.length} new FAIL — ${items}`, FAIL_SUMMARY_MAX_CHARS);
}
