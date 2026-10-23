/**
 * src/entries/board.ts — the typed surface over the storage kernel:
 * write validation, the read window, id-based detail unfold, and the
 * boolean grep (`,` = OR, `&` = AND, AND binds tighter; case-insensitive
 * over text and detail; a miss is an honest empty list).
 */
import { BoardStore, boardDir, type StoreOptions } from "../store/store.js";
import { validateDraft, type Entry, type EntryDraft } from "./types.js";

/** One grep row: always carries the id; `(in detail)` marks rows whose
 *  match relied on detail (gate review b) — `read --id` is the follow-up. */
export interface GrepRow {
  entry: Entry;
  matchedInDetail: boolean;
}

export class TypedBoard {
  readonly store: BoardStore;

  constructor(store: BoardStore) {
    this.store = store;
  }

  static open(room: string, opts: StoreOptions = {}): TypedBoard {
    return new TypedBoard(new BoardStore(boardDir(room), opts));
  }

  write(draft: Partial<EntryDraft> & Record<string, unknown>): Entry {
    return this.store.append({ ...validateDraft(draft) }) as unknown as Entry;
  }

  /** Newest-first summary window; limit clamped to the configured max. */
  read(limit?: number): Entry[] {
    const wanted = limit === undefined ? this.store.limits.readWindowDefault : limit;
    const clamped = Math.max(1, Math.min(wanted, this.store.limits.readWindowMax));
    return this.store.read(clamped) as unknown as Entry[];
  }

  /** Unfold: the full record including `detail` (constraint #3). */
  readById(id: string): Entry | undefined {
    return this.store.byId(id) as Entry | undefined;
  }

  /**
   * Boolean full-text search. Grammar: `a,b&c` = a OR (b AND c) — AND
   * binds tighter. Terms are case-insensitive substrings over `text` and
   * `detail`. A miss returns []; a row that matched only through detail is
   * marked so a summary line that hides the match never confuses.
   */
  grep(query: string): GrepRow[] {
    const groups = query
      .split(",")
      .map((group) => group.split("&").map((term) => term.trim().toLowerCase()))
      .filter((terms) => terms.length > 0 && terms.every((term) => term !== ""));
    if (groups.length === 0) {
      throw new Error(`grep_invalid: query has no usable terms: ${JSON.stringify(query)}`);
    }
    const rows: GrepRow[] = [];
    // Full visible span, not the read window: rotated-but-alive segments
    // must stay greppable (DESIGN §2) — the window is a PRESENTATION bound
    // for read, never a search boundary. TTL already bounds the span.
    for (const entry of this.store.read(Number.MAX_SAFE_INTEGER) as unknown as Entry[]) {
      const inText = (term: string): boolean => entry.text.toLowerCase().includes(term);
      const inDetail = (term: string): boolean =>
        entry.detail !== undefined && entry.detail.toLowerCase().includes(term);
      let matchedTextOnly = false;
      let matchedViaDetail = false;
      for (const terms of groups) {
        if (!terms.every((term) => inText(term) || inDetail(term))) continue;
        if (terms.every((term) => inText(term))) matchedTextOnly = true;
        else matchedViaDetail = true;
      }
      if (!matchedTextOnly && !matchedViaDetail) continue;
      rows.push({ entry, matchedInDetail: !matchedTextOnly && matchedViaDetail });
    }
    return rows;
  }
}
