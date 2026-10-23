// src/extension/runtime.ts — the per-session board runtime: room
// resolution, a store cache (one BoardStore per room), and the AUTO-JOIN
// peer lifecycle. This is what makes the board NATIVE alongside pi-mesh:
// once `piboard join <room>` has been run (or $PI_BOARD_ROOM is set),
// every session that loads the extension connects a board peer to that
// room automatically — no skill, no manual step. The peer exists for ONE
// purpose: announcing writes (§5.3); reads/greps are always local store
// operations and work even when the peer is down (honest degraded mode).
import { randomBytes } from "node:crypto";
import { boardDir, BoardStore } from "../store/store.js";
import { connectBoardPeer, type BoardPeer } from "../mesh/peer.js";
import { loadBoardConfig } from "../cli/ctx.js";

export interface BoardRuntime {
  /** The board room for this session, when one is resolvable. */
  room: string | undefined;
  /** Read-only membership (from the joined config or $PI_BOARD_OBSERVER). */
  observer: boolean;
  /** The auto-joined announce peer — null when no room or connect failed. */
  peer: BoardPeer | null;
  /** Honest one-line status of the auto-join (shown in tool results). */
  peerStatus: string;
  getStore(room?: string): BoardStore;
  close(): Promise<void>;
}

/** Room for the session: $PI_BOARD_ROOM > the config saved by `piboard
 *  join`. Explicit tool params override per call (never here). */
export function sessionRoom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.PI_BOARD_ROOM;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    return loadBoardConfig(env)?.room;
  } catch {
    return undefined; // an unreadable config degrades to no auto-join — tools still work with an explicit room
  }
}

/** Per-session peer alias: the joined alias + a short random suffix, so N
 *  sessions on one machine never collide on strictAlias (the cli-<rand>
 *  house pattern, board-side). */
function sessionPeerAlias(configured: string | undefined, env: NodeJS.ProcessEnv): string {
  const base = env.PI_BOARD_ALIAS ?? configured ?? "board";
  return `${base}-${randomBytes(2).toString("hex")}`;
}

/**
 * Build the runtime and AUTO-JOIN the room (fire-and-forget connect: a
 * broker that is down must never break session start — tools answer in
 * degraded store-only mode with an honest status line).
 */
export async function buildBoardRuntime(env: NodeJS.ProcessEnv = process.env): Promise<BoardRuntime> {
  const room = sessionRoom(env);
  const config = room === undefined ? undefined : (() => { try { return loadBoardConfig(env); } catch { return undefined; } })();
  const observer = env.PI_BOARD_OBSERVER === "true" || config?.observer === true;

  const stores = new Map<string, BoardStore>();
  let peer: BoardPeer | null = null;
  let peerStatus: string;

  if (room === undefined) {
    peerStatus = "no board room joined — store-only mode (pass room explicitly, or run `piboard join <room>`)";
  } else {
    try {
      peer = await connectBoardPeer({
        room,
        observer,
        alias: sessionPeerAlias(config?.alias, env),
        ...(env.PI_BOARD_RUNTIME_DIR !== undefined && env.PI_BOARD_RUNTIME_DIR !== ""
          ? { runtimeDir: env.PI_BOARD_RUNTIME_DIR }
          : {}),
      });
      peerStatus = `auto-joined ${room} as ${observer ? "observer" : "member"}`;
    } catch (err) {
      peerStatus = `auto-join failed (${err instanceof Error ? err.message : String(err)}) — store-only mode`;
    }
  }

  return {
    room,
    observer,
    peer,
    peerStatus,
    getStore(explicit?: string): BoardStore {
      const target = explicit ?? room;
      if (target === undefined) throw new Error("no room: pass room explicitly or run `piboard join <room>`");
      let store = stores.get(target);
      if (store === undefined) {
        store = new BoardStore(boardDir(target));
        stores.set(target, store);
      }
      return store;
    },
    close: async () => {
      if (peer !== null) await peer.close().catch(() => {});
    },
  };
}
