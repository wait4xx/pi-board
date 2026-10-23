/**
 * src/entries/types.ts — the five entry types (closed set) and the typed
 * entry shape. Unknown types are rejected at write time; CLAIM carries no
 * authority (it pairs with `mesh_claim` leases — the board never enforces).
 */

export const ENTRY_TYPES = ["OBSERVED", "FACT", "FAIL", "CLAIM", "PATCH_SUMMARY"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export interface EntryDraft {
  type: EntryType;
  author: string;
  room: string;
  /** The summary line — always short, cheap to read at a turn boundary. */
  text: string;
  /** Optional long form; surfaces only via read --id. */
  detail?: string;
  /** Optional git-reachable anchor (path, commit, URL). */
  ref?: string;
  /** CLAIM only: annotate the `mesh_claim` lease id for correlation. */
  leaseRef?: string;
}

export interface Entry extends EntryDraft {
  id: string;
  at: string;
}

export function isEntryType(value: unknown): value is EntryType {
  return typeof value === "string" && (ENTRY_TYPES as readonly string[]).includes(value);
}

/** Closed-set validation with honest, named errors (before any storage call). */
export function validateDraft(draft: Partial<EntryDraft> & Record<string, unknown>): EntryDraft {
  if (!isEntryType(draft.type)) {
    throw new Error(`entry_invalid: type must be one of ${ENTRY_TYPES.join("|")}, got: ${String(draft.type)}`);
  }
  if (typeof draft.author !== "string" || draft.author.length === 0) {
    throw new Error("entry_invalid: author is required");
  }
  if (typeof draft.room !== "string" || draft.room.length === 0) {
    throw new Error("entry_invalid: room is required");
  }
  if (typeof draft.text !== "string" || draft.text.length === 0) {
    throw new Error("entry_invalid: text is required");
  }
  if (draft.detail !== undefined && typeof draft.detail !== "string") {
    throw new Error("entry_invalid: detail must be a string");
  }
  if (draft.ref !== undefined && typeof draft.ref !== "string") {
    throw new Error("entry_invalid: ref must be a string");
  }
  if (draft.leaseRef !== undefined && typeof draft.leaseRef !== "string") {
    throw new Error("entry_invalid: leaseRef must be a string");
  }
  return {
    type: draft.type,
    author: draft.author,
    room: draft.room,
    text: draft.text,
    ...(draft.detail !== undefined ? { detail: draft.detail } : {}),
    ...(draft.ref !== undefined ? { ref: draft.ref } : {}),
    ...(draft.leaseRef !== undefined ? { leaseRef: draft.leaseRef } : {}),
  };
}
