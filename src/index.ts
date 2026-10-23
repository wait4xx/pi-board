// src/index.ts — the package surface (v0.1 slice).
//
// Layers, mirroring the pi-mesh / pi-subagents family layout: shared
// (named bounds) → store (append-only JSONL kernel) → entries (typed
// entries, read window, boolean grep) → mesh (peer join, write gates,
// notify). The CLI (cli/piboard.ts) is the `piboard` bin, not an import
// surface. Explicit named re-exports only — no star re-exports.
export const BOARD_NAME = "pi-board";

export {
  ENTRY_TYPES,
  defaultAuthor,
  entryLine,
  grepBoard,
  grepLine,
  isEntryType,
  parseGrepQuery,
  readWindow,
  unfoldById,
  writeEntry,
  type BoardEntry,
  type EntryType,
  type GrepQuery,
  type GrepRow,
  type WriteDraft,
} from "./entries/entries.js";
export {
  announceWrite,
  broadcastBody,
  failSummaryLine,
  selectNewFails,
  type AnnounceResult,
  type BoardEntryType,
  type NotifiableEntry,
} from "./mesh/notify.js";
export { checkWriteGate, gateRefusalText, guardWrite } from "./mesh/gates.js";
export { connectBoardPeer, type BoardPeer, type BoardPeerOpts } from "./mesh/peer.js";
export {
  ENTRY_TTL_MS,
  FORBIDDEN_KEY_PATTERNS,
  GREP_LIMIT_DEFAULT,
  MAX_DETAIL_CHARS,
  MAX_ENTRIES,
  MAX_TEXT_CHARS,
  MAX_TOTAL_BYTES,
  READ_WINDOW_DEFAULT,
  READ_WINDOW_MAX,
  SEGMENT_MAX_BYTES,
  SEGMENT_MAX_ENTRIES,
  STATE_DIR_NAME,
  loadLimits,
  type Limits,
} from "./shared/limits.js";
export {
  BoardFullError,
  BoardStore,
  ForbiddenKeyError,
  boardDir,
  stateRoot,
  type StoredEntry,
  type StoreOptions,
} from "./store/store.js";
