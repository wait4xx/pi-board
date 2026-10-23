// cli/cmd/watch.ts — the turn-boundary FAIL digest (DESIGN §5.3, the
// maintainer's cheaper-first-step: one skimmable line, normal priority,
// never an urgent frame). One-shot: prints FAILs newer than the saved
// cursor, then advances it — an honest silence (exit 0, no output) when
// there is nothing new.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { say, sayErr } from "../out.js";
import { EXIT_OK, EXIT_USAGE } from "../codes.js";
import { resolveRoom } from "../ctx.js";
import { boardDir, BoardStore } from "../../store/store.js";
import { failSummaryLine, selectNewFails, type NotifiableEntry } from "../../mesh/notify.js";
import { readWindow, type EntryType } from "../../entries/entries.js";

export const WATCH_USAGE = "usage: piboard watch [--room ROOM]";

export function cmdWatch(values: Map<string, string>): number {
  const roomRes = resolveRoom(values);
  if (!roomRes.ok) {
    sayErr(roomRes.error);
    return EXIT_USAGE;
  }
  const dir = boardDir(roomRes.room);
  const store = new BoardStore(dir);
  const cursorPath = join(dir, "watch.json");

  let lastAt = 0;
  if (existsSync(cursorPath)) {
    try {
      const raw = JSON.parse(readFileSync(cursorPath, "utf8")) as { lastAtMs?: unknown };
      if (typeof raw.lastAtMs === "number" && Number.isFinite(raw.lastAtMs)) lastAt = raw.lastAtMs;
    } catch {
      lastAt = 0; // a torn cursor degrades to "everything is new" — honest
    }
  }

  const notifiable: NotifiableEntry[] = (readWindow(store, store.limits.readWindowMax) as Array<{
    id: string;
    type: EntryType;
    text: string;
    at?: string;
  }>).map((e) => ({ id: e.id, type: e.type, short: e.text, at: e.at }));
  const line = failSummaryLine(selectNewFails(notifiable, lastAt));
  if (line !== "") say(line);

  writeFileSync(cursorPath, `${JSON.stringify({ lastAtMs: Date.now() })}\n`, "utf8");
  return EXIT_OK;
}
