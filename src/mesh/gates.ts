// src/mesh/gates.ts — the board's OWN write gate (DESIGN §5.2, task_0006).
//
// This is the second layer of defense in depth; the broker's routeMsg is
// the first. It must therefore hold even when the broker's view is wrong —
// notably during the reconnect window where an observer peer has silently
// re-hello'd as member (the ctl bug class, see peer.ts) — so the decision
// is based on the board's CONFIGURED identity, not on broker state.
//
// Semantics mirror pi-mesh routeMsg's direct/broadcast sender checks, in
// the same order:
//   1. room membership first  → not_member (board word: not_a_member)
//   2. observer role second   → observer_readonly
//   (broker continues with rate limit + policy; those stay broker-side)
// Reads never pass through this gate — it guards write paths only.
import type { BoardPeer } from "./peer.js";

export interface WriteGateInput {
  /** The board's configured membership (peer.observer). */
  observer: boolean;
  /** The board's single room (v0.1). */
  room: string;
  /** Room the write targets; defaults to the board's room. */
  targetRoom?: string;
}

export type WriteGateDecision =
  | { ok: true }
  | { ok: false; status: "blocked"; reason: "observer_readonly" | "not_a_member"; detail: string };

/**
 * Decide a write. Order is load-bearing: membership before observer role,
 * exactly like routeMsg — a peer outside the room is not_a_member even if
 * it would also be read-only, matching which failure the broker reports.
 */
export function checkWriteGate(input: WriteGateInput): WriteGateDecision {
  const target = input.targetRoom ?? input.room;
  if (target !== input.room) {
    return {
      ok: false,
      status: "blocked",
      reason: "not_a_member",
      detail: `board is not a member of "${target}" — it lives in "${input.room}" (single room in v0.1)`,
    };
  }
  if (input.observer) {
    return {
      ok: false,
      status: "blocked",
      reason: "observer_readonly",
      detail: "board joined as observer (--observer): every write path is refused; reads are unaffected",
    };
  }
  return { ok: true };
}

/** Human-readable one-liner for a refused write (CLI/notify wording). */
export function gateRefusalText(decision: Extract<WriteGateDecision, { ok: false }>): string {
  return `blocked: ${decision.reason} — ${decision.detail}`;
}

/**
 * The single enforcement point future write paths (notify, CLI) call: gate
 * first, then the write itself. A refused write never reaches the storage
 * kernel or the broker. Returns the gate decision so callers surface the
 * honest reason verbatim.
 */
export async function guardWrite<T>(
  peer: BoardPeer,
  write: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; status: "blocked"; reason: string; detail: string }> {
  const decision = checkWriteGate({ observer: peer.observer, room: peer.room });
  if (!decision.ok) return { ok: false, status: "blocked", reason: decision.reason, detail: decision.detail };
  return { ok: true, value: await write() };
}
