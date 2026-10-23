// src/extension/runtime.ts — the per-session board runtime: room
// resolution, a store cache (one BoardStore per room), and the AUTO-JOIN
// peer lifecycle. This is what makes the board NATIVE alongside pi-mesh:
// once `piboard join <room>` has been run (or $PI_BOARD_ROOM is set),
// every session that loads the extension connects a board peer to that
// room automatically — no skill, no manual step. The peer exists for ONE
// purpose: announcing writes (§5.3); reads/greps are always local store
// operations.
//
// AVAILABILITY CONTRACT (external review, PR #2): the runtime is built
// SYNCHRONOUSLY in store-only form at session_start — tools answer
// immediately, reads/greps with an explicit room never wait on the peer.
// The peer attaches in the background; if the broker is down or slow the
// session stays fully usable (peerStatus says so honestly), and the first
// announceable write retries the connection once (lazy reconnect).
import { randomBytes } from "node:crypto";
import { boardDir, BoardStore } from "../store/store.js";
import { connectBoardPeer, type BoardPeer } from "../mesh/peer.js";
import { loadBoardConfig } from "../cli/ctx.js";

export interface BoardRuntime {
  /** The board room for this session, when one is resolvable. */
  room: string | undefined;
  /** Read-only membership (from the joined config or $PI_BOARD_OBSERVER). */
  observer: boolean;
  /** The auto-joined announce peer — null while connecting / failed / none. */
  peer: BoardPeer | null;
  /** Honest one-line status of the auto-join (shown in tool results). */
  peerStatus: string;
  getStore(room?: string): BoardStore;
  /**
   * Lazy single reconnect: called before an announceable write when
   * peer === null. No-ops when a peer exists, no room is joined, the
   * board is read-only, or an attempt (background or lazy) already ran —
   * one attempt per session, never a retry loop.
   */
  ensurePeer(): Promise<void>;
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

/** One peer connection attempt; fills peer/peerStatus on the runtime. */
async function attachPeer(rt: BoardRuntime, env: NodeJS.ProcessEnv): Promise<void> {
  const room = rt.room;
  if (room === undefined) return;
  try {
    const peer = await connectBoardPeer({
      room,
      observer: rt.observer,
      alias: sessionPeerAlias((rt as { aliasBase?: string }).aliasBase, env),
      noReconnect: true, // ONE attempt — a failed connect must never leave a retrying client behind
      ...(env.PI_BOARD_RUNTIME_DIR !== undefined && env.PI_BOARD_RUNTIME_DIR !== ""
        ? { runtimeDir: env.PI_BOARD_RUNTIME_DIR }
        : {}),
    });
    rt.peer = peer;
    rt.peerStatus = `auto-joined ${room} as ${rt.observer ? "observer" : "member"}`;
  } catch (err) {
    rt.peerStatus = `auto-join failed (${err instanceof Error ? err.message : String(err)}) — store-only mode`;
  }
}

/**
 * Build the runtime SYNCHRONOUSLY in store-only form (cheap, fs-only) and
 * start the background peer attach. Tools are usable the instant this
 * returns — the availability contract above.
 */
export function buildBoardRuntime(env: NodeJS.ProcessEnv = process.env): BoardRuntime {
  let config: { room: string; observer: boolean; alias: string } | undefined;
  try {
    config = loadBoardConfig(env);
  } catch {
    config = undefined; // degraded honestly — sessionRoom() reports the same
  }
  const room = env.PI_BOARD_ROOM !== undefined && env.PI_BOARD_ROOM !== "" ? env.PI_BOARD_ROOM : config?.room;
  const observer = env.PI_BOARD_OBSERVER === "true" || config?.observer === true;

  const stores = new Map<string, BoardStore>();
  let peerAttempted = false;
  const rt: BoardRuntime = {
    room,
    observer,
    peer: null,
    peerStatus:
      room === undefined
        ? "no board room joined — store-only mode (pass room explicitly, or run `piboard join <room>`)"
        : "connecting…",
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
    ensurePeer: async () => {
      if (rt.peer !== null || room === undefined || rt.observer || peerAttempted) return;
      peerAttempted = true;
      await attachPeer(rt, env);
    },
    close: async () => {
      if (rt.peer !== null) await rt.peer.close().catch(() => {});
    },
  };
  if (room !== undefined) {
    peerAttempted = true; // the background attempt counts as the session's one shot
    void attachPeer(rt, env).catch(() => {});
  }
  return rt;
}
