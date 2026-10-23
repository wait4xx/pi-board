// cli/cmd/write.ts — append one typed entry, then announce it to the room
// when the board is joined. Validation mirrors the pi-mesh validate table:
// every bound comes from shared/limits and every violation is a usage
// error (exit 2) BEFORE anything touches the store; the kernel re-checks
// everything for programmatic callers (defense in depth). The gate refusal
// is exit 4; a failed announcement NEVER undoes the write (notify.ts
// contract) — the entry is persisted, the status line says so.
import { readFileSync } from "node:fs";
import { say, sayErr } from "../out.js";
import { EXIT_ERROR, EXIT_OK, EXIT_REFUSED, EXIT_USAGE } from "../codes.js";
import { resolveRoom } from "../ctx.js";
import { checkWriteGate } from "../../mesh/gates.js";
import { announceWrite, type NotifiableEntry } from "../../mesh/notify.js";
import { connectBoardPeer } from "../../mesh/peer.js";
import { boardDir, BoardStore } from "../../store/store.js";
import { loadLimits } from "../../shared/limits.js";
import { defaultAuthor, entryLine, isEntryType, writeEntry, type EntryType } from "../../entries/entries.js";

export const WRITE_USAGE =
  "usage: piboard write --type OBSERVED|FACT|FAIL|CLAIM|PATCH_SUMMARY --text \"…\" [--detail-file -|PATH] [--ref R] [--claim-id ID] [--lease-ref L] [--room ROOM]";

export interface WriteArgs {
  type: EntryType;
  text: string;
  detail?: string;
  ref?: string;
  claimId?: string;
  leaseRef?: string;
  room?: string;
}

export type WriteParse =
  | { ok: true; args: WriteArgs }
  | { ok: false; error: string };

/** stdin body reader (mirror of the pi-mesh send.ts readStdinBody). */
export async function readStdinBody(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function parseWriteArgs(values: Map<string, string>): Promise<WriteParse> {
  const limits = loadLimits();
  const type = values.get("type");
  if (type === undefined) return { ok: false, error: "write needs --type (OBSERVED | FACT | FAIL | CLAIM | PATCH_SUMMARY)" };
  if (!isEntryType(type)) {
    return { ok: false, error: `invalid --type "${type}" — use one of OBSERVED | FACT | FAIL | CLAIM | PATCH_SUMMARY` };
  }
  const text = values.get("text");
  if (text === undefined || text === "") return { ok: false, error: "write needs --text \"…\"" };
  if (text.length > limits.maxTextChars) {
    return { ok: false, error: `--text is ${text.length} chars (max ${limits.maxTextChars})` };
  }
  let detail: string | undefined;
  const detailFile = values.get("detail-file");
  if (detailFile !== undefined) {
    if (detailFile === "-" && process.stdin.isTTY === true) {
      return { ok: false, error: "--detail-file - refuses an interactive terminal (pipe the content or pass a file path)" };
    }
    try {
      detail = detailFile === "-" ? await readStdinBody() : readFileSync(detailFile, "utf8");
    } catch (err) {
      return { ok: false, error: `detail unreadable (${detailFile}): ${err instanceof Error ? err.message : String(err)}` };
    }
    if (detail.length > limits.maxDetailChars) {
      return { ok: false, error: `--detail-file is ${detail.length} chars (max ${limits.maxDetailChars})` };
    }
  }
  return {
    ok: true,
    args: {
      type,
      text,
      ...(detail !== undefined && detail !== "" ? { detail } : {}),
      ...(values.get("ref") !== undefined ? { ref: values.get("ref")! } : {}),
      ...(values.get("claim-id") !== undefined ? { claimId: values.get("claim-id")! } : {}),
      ...(values.get("lease-ref") !== undefined ? { leaseRef: values.get("lease-ref")! } : {}),
      ...(values.get("room") !== undefined ? { room: values.get("room")! } : {}),
    },
  };
}

export async function cmdWrite(args: WriteArgs): Promise<number> {
  const roomRes = resolveRoom(new Map(args.room !== undefined ? [["room", args.room]] : []));
  if (!roomRes.ok) {
    sayErr(roomRes.error);
    return EXIT_USAGE;
  }
  const { room, config, joined } = roomRes;
  const observer = joined && config !== undefined && config.observer;

  // the board's own write gate (DESIGN §5.2): refused writes never touch
  // the storage kernel
  const gate = checkWriteGate({ observer, room });
  if (!gate.ok) {
    sayErr(`${gate.reason} — ${gate.detail}`);
    return EXIT_REFUSED;
  }

  const store = new BoardStore(boardDir(room));
  let entry;
  try {
    entry = writeEntry(store, { ...args, room, author: defaultAuthor() });
  } catch (err) {
    sayErr(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }
  say(entryLine(entry));

  if (!joined) return EXIT_OK; // store-only write: nothing to announce
  try {
    const peer = await connectBoardPeer({ room, observer, alias: config!.alias });
    try {
      const notifiable: NotifiableEntry = { id: entry.id, type: entry.type, room, short: entry.text, at: entry.at };
      const res = await announceWrite(peer, notifiable);
      if (!res.ok) {
        say(
          `piboard: announcement not delivered (${res.status}${res.reason !== undefined ? `: ${res.reason}` : ""}) — entry ${entry.id} is persisted`,
        );
      }
    } finally {
      await peer.close().catch(() => {});
    }
  } catch (err) {
    say(
      `piboard: announcement skipped (${err instanceof Error ? err.message : String(err)}) — entry ${entry.id} is persisted`,
    );
  }
  return EXIT_OK;
}
