// cli/cmd/join.ts — connect the board peer to a room (member or read-only
// observer) and persist the joined face to <root>/board.json. Honest
// outcomes: joined (0) or an error (1) — an unreachable broker, a taken
// alias or a missing pi-mesh-extension peer is reported verbatim, and
// nothing is persisted on failure.
import { say, sayErr } from "../out.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "../codes.js";
import { saveBoardConfig } from "../ctx.js";
import { connectBoardPeer } from "../../mesh/peer.js";

export const JOIN_USAGE = "usage: piboard join <room> [--observer] [--alias A]";

export async function cmdJoin(
  room: string | undefined,
  opts: { observer: boolean; alias?: string },
): Promise<number> {
  if (room === undefined || room === "") {
    sayErr("join needs a room");
    return EXIT_USAGE;
  }
  // default alias carries the room (board-muse, not a bare board) so the
  // sender name says which board speaks; an explicit --alias wins
  const alias = opts.alias ?? `board-${room}`.slice(0, 32);
  let peer;
  try {
    peer = await connectBoardPeer({ room, observer: opts.observer, alias });
  } catch (err) {
    sayErr(`join failed: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_ERROR;
  }
  try {
    const path = saveBoardConfig({ room, observer: opts.observer, alias: peer.alias });
    say(
      `joined ${room} as ${opts.observer ? "observer (read-only)" : "member"} — alias ${peer.alias}`,
    );
    say(`board config saved: ${path}`);
    return EXIT_OK;
  } finally {
    await peer.close().catch(() => {});
  }
}
