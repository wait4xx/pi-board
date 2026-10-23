// cli/cmd/grep.ts — full-history boolean search (`,` = OR, `&` = AND,
// case-insensitive; DESIGN §4). A miss is exit 0 with empty output —
// honest, never an error, never invented rows.
import { say, sayErr } from "../out.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "../codes.js";
import { resolveRoom } from "../ctx.js";
import { boardDir, BoardStore } from "../../store/store.js";
import { grepBoard, grepLine, isEntryType } from "../../entries/entries.js";

export const GREP_USAGE = "usage: piboard grep \"a,b&c\" [--type T] [--limit N] [--room ROOM]";

export function cmdGrep(query: string | undefined, values: Map<string, string>): number {
  if (query === undefined || query === "") {
    sayErr("grep needs a query");
    return EXIT_USAGE;
  }
  const typeRaw = values.get("type");
  if (typeRaw !== undefined && !isEntryType(typeRaw)) {
    sayErr(`invalid --type "${typeRaw}"`);
    return EXIT_USAGE;
  }
  let limit: number | undefined;
  const limitRaw = values.get("limit");
  if (limitRaw !== undefined) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(n) || n <= 0) {
      sayErr(`invalid --limit "${limitRaw}"`);
      return EXIT_USAGE;
    }
    limit = n;
  }
  const roomRes = resolveRoom(values);
  if (!roomRes.ok) {
    sayErr(roomRes.error);
    return EXIT_USAGE;
  }
  const store = new BoardStore(boardDir(roomRes.room));
  let rows;
  try {
    rows = grepBoard(store, query, {
      ...(limit !== undefined ? { limit } : {}),
      ...(typeRaw !== undefined ? { type: typeRaw } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // a malformed query is a USAGE error, same contract as an empty one —
    // scripts branch on exit codes, not on which flavor of bad input
    if (message.startsWith("invalid_query")) {
      sayErr(message);
      return EXIT_USAGE;
    }
    sayErr(message);
    return EXIT_ERROR;
  }
  for (const row of rows) say(grepLine(row));
  return EXIT_OK;
}
