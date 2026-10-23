// cli/cmd/read.ts — the recent-memory window (one-line summaries, newest
// first) or the unfold of one entry's detail via --id (the only path
// detail takes to a reader, DESIGN §3.3). Unknown id = exit 3, honest.
import { say, sayErr } from "../out.js";
import { EXIT_NOT_FOUND, EXIT_OK, EXIT_USAGE } from "../codes.js";
import { resolveRoom } from "../ctx.js";
import { boardDir, BoardStore } from "../../store/store.js";
import { entryLine, readWindow, unfoldById } from "../../entries/entries.js";

export const READ_USAGE = "usage: piboard read [--id ID] [--limit N] [--room ROOM]";

export function cmdRead(values: Map<string, string>): number {
  const roomRes = resolveRoom(values);
  if (!roomRes.ok) {
    sayErr(roomRes.error);
    return EXIT_USAGE;
  }
  const store = new BoardStore(boardDir(roomRes.room));

  const id = values.get("id");
  if (id !== undefined) {
    const entry = unfoldById(store, id);
    if (entry === undefined) {
      sayErr(`no such entry: ${id}`);
      return EXIT_NOT_FOUND;
    }
    say(`${entry.id} ${entry.type} ${entry.author} ${entry.at}`);
    say(entry.text);
    if (typeof entry.detail === "string") {
      say("--- detail ---");
      say(entry.detail);
    }
    if (typeof entry.ref === "string") say(`ref: ${entry.ref}`);
    if (typeof entry.claimId === "string") say(`claim: ${entry.claimId}`);
    if (typeof entry.leaseRef === "string") say(`lease: ${entry.leaseRef}`);
    return EXIT_OK;
  }

  let limit = store.limits.readWindowDefault;
  const limitRaw = values.get("limit");
  if (limitRaw !== undefined) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(n) || n <= 0) {
      sayErr(`invalid --limit "${limitRaw}"`);
      return EXIT_USAGE;
    }
    limit = Math.min(n, store.limits.readWindowMax); // §3.3: capped by READ_WINDOW_MAX
  }
  for (const entry of readWindow(store, limit)) say(entryLine(entry));
  return EXIT_OK;
}
