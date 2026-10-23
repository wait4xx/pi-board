// src/entries/entries.ts — task_0004: typed entries, read shaping, boolean
// grep (DESIGN §3). The validation authority: the five types are a closed
// set, `text` is always present and always short, `detail` unfolds only via
// read --id. Grep is the long-tail path: `,` = OR, `&` = AND (binds
// tighter), case-insensitive substring over text AND detail, built ON the
// store's grepSubstr primitive so rotated segments stay searchable
// (store.ts: "the boolean algebra and output shaping live in the entries
// layer; this proves the primitive every segment stays searchable"). A miss
// is an honest empty — exit 0, zero rows, never a guess.
import { userInfo } from "node:os";
import { BoardStore, type StoredEntry } from "../store/store.js";

/** The closed set (DESIGN §3.1). Unknown types are rejected at write time. */
export const ENTRY_TYPES = ["OBSERVED", "FACT", "FAIL", "CLAIM", "PATCH_SUMMARY"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export function isEntryType(value: string): value is EntryType {
  return (ENTRY_TYPES as readonly string[]).includes(value);
}

/** The full stored shape (DESIGN §3.2). */
export interface BoardEntry extends StoredEntry {
  type: EntryType;
  author: string;
  room: string;
  text: string;
  detail?: string;
  ref?: string;
  claimId?: string;
  leaseRef?: string;
}

export interface WriteDraft {
  type: EntryType;
  room: string;
  text: string;
  detail?: string;
  ref?: string;
  claimId?: string;
  leaseRef?: string;
  author?: string;
}

/** Author of record: explicit > $PI_BOARD_AUTHOR > the OS user. */
export function defaultAuthor(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_BOARD_AUTHOR;
  if (override !== undefined && override !== "") return override;
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Append one typed entry through the storage kernel. The kernel owns
 * forbidden-key scanning and size caps (task_0003); this layer owns type
 * validation and the field contract. Validation order: type first (a
 * wrong type is a usage bug, not a storage event), then the contract.
 */
export function writeEntry(store: BoardStore, draft: WriteDraft): BoardEntry {
  if (!isEntryType(draft.type)) {
    throw new Error(`invalid_type: ${draft.type} is not one of ${ENTRY_TYPES.join(" | ")}`);
  }
  if (typeof draft.text !== "string" || draft.text.trim() === "") {
    throw new Error("missing_text: text is required and must be non-empty");
  }
  const record: Record<string, unknown> = {
    type: draft.type,
    author: draft.author ?? defaultAuthor(),
    room: draft.room,
    text: draft.text,
    ...(draft.detail !== undefined && draft.detail !== "" ? { detail: draft.detail } : {}),
    ...(draft.ref !== undefined && draft.ref !== "" ? { ref: draft.ref } : {}),
    ...(draft.claimId !== undefined && draft.claimId !== "" ? { claimId: draft.claimId } : {}),
    ...(draft.leaseRef !== undefined && draft.leaseRef !== "" ? { leaseRef: draft.leaseRef } : {}),
  };
  return store.append(record) as BoardEntry;
}

// ---- read shaping (§3.3) ----

/** One skimmable line for the window: `id TYPE author: text`. */
export function entryLine(entry: BoardEntry): string {
  return `${entry.id} ${entry.type} ${entry.author}: ${entry.text}`;
}

/** The newest window, one-line summaries only. */
export function readWindow(store: BoardStore, limit: number): BoardEntry[] {
  return store.read(limit) as BoardEntry[];
}

/** Unfold `detail` for one entry — the ONLY path detail takes to a reader. */
export function unfoldById(store: BoardStore, id: string): BoardEntry | undefined {
  return store.byId(id) as BoardEntry | undefined;
}

// ---- boolean grep (§3.3, §4) ----

/** A parsed query: OR of AND-groups (`,` splits OR, `&` splits AND; AND
 *  binds tighter — `foo,bar&baz` = foo OR (bar AND baz)). */
export interface GrepQuery {
  groups: string[][];
}

export function parseGrepQuery(query: string): GrepQuery {
  const groups = query
    .split(",")
    .map((group) => group.split("&").map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))
    .filter((group) => group.length > 0);
  if (groups.length === 0) throw new Error(`invalid_query: "${query}" has no non-empty terms`);
  return { groups };
}

export interface GrepRow {
  entry: BoardEntry;
  /** True when the match required `detail` — the text line alone would not
   *  show it; `read --id` is the natural follow-up (gate review b). */
  inDetail: boolean;
}

/** Monotonic sequence of a board id (`b<seq36>` → int), 0 when unparsable. */
function seqOf(id: string): number {
  const n = Number.parseInt(id.slice(1), 36);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Full-history search, newest-first, bounded. Terms are matched through
 * the store's grepSubstr (case-insensitive, text then detail, every
 * segment — rotated included), then combined per the boolean algebra.
 * inDetail marks a row the text field alone would NOT have matched.
 */
export function grepBoard(
  store: BoardStore,
  query: string,
  opts: { limit?: number; type?: EntryType } = {},
): GrepRow[] {
  const parsed = parseGrepQuery(query);
  const limit = opts.limit ?? store.limits.grepLimitDefault;

  // per-term match sets, built from the store primitive
  const terms = [...new Set(parsed.groups.flat())];
  const byId = new Map<string, { entry: BoardEntry; textHit: Set<string>; anyHit: Set<string> }>();
  for (const term of terms) {
    for (const { entry, inDetail } of store.grepSubstr(term)) {
      let rec = byId.get(entry.id);
      if (rec === undefined) {
        rec = { entry: entry as BoardEntry, textHit: new Set<string>(), anyHit: new Set<string>() };
        byId.set(entry.id, rec);
      }
      rec.anyHit.add(term);
      if (!inDetail) rec.textHit.add(term); // grepSubstr: inDetail=false ⟺ hit in text
    }
  }

  const rows = [...byId.values()].sort((a, b) => seqOf(b.entry.id) - seqOf(a.entry.id)); // newest first
  const out: GrepRow[] = [];
  for (const rec of rows) {
    if (opts.type !== undefined && rec.entry.type !== opts.type) continue;
    const matched = parsed.groups.some((g) => g.every((t) => rec.anyHit.has(t)));
    if (!matched) continue;
    const textOnly = parsed.groups.some((g) => g.every((t) => rec.textHit.has(t)));
    out.push({ entry: rec.entry, inDetail: !textOnly });
    if (out.length >= limit) break;
  }
  return out;
}

/** One result line: `id TYPE author: text` + `(in detail)` marker. */
export function grepLine(row: GrepRow): string {
  return `${entryLine(row.entry)}${row.inDetail ? " (in detail)" : ""}`;
}
