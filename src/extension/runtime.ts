// src/extension/runtime.ts — the per-session board runtime: room
// resolution, a store cache (one TypedBoard per room), and the AUTO-JOIN
// peer lifecycle. This is what makes the board NATIVE alongside pi-mesh:
// once `piboard join <room>` has been run (or $PI_BOARD_ROOM is set),
// every session that loads the extension connects a board peer to that
// room automatically — no skill, no manual step.
//
// ROLE MODEL (v0.2 ruling): the auto-join peer is OBSERVER by default —
// a session that never ran a member join gets READ-ONLY presence, never
// write capability. Member presence requires the explicit config written
// by `piboard join` (observer: false). $PI_BOARD_OBSERVER=true can force
// observer even over a member config (the fail-safe direction only).
//
// ANNOUNCE ARCHITECTURE (v0.2 ruling): the extension NEVER announces —
// the watermark-daemon from `piboard join` owns every broadcast (DESIGN
// §5.3 unchanged). The peer exists for presence/role; board_write only
// appends to the store the daemon polls.
//
// NO-SPAWN CONTRACT: the attach probes the broker socket first and, for
// the connect window only, sets MESH_NO_AUTO_BROKER — a board extension
// must never be the reason a broker appears on a machine (the env is
// scoped and restored, never left global: pi-mesh's own extension keeps
// its auto-spawn behavior).
//
// AVAILABILITY CONTRACT: the runtime is built SYNCHRONOUSLY in store-only
// form at session_start — tools answer immediately, reads/greps with an
// explicit room never wait on the peer. The peer attaches in the
// background; if the broker is down the session stays fully usable
// (peerStatus says so honestly), and the next announceable-gated action
// retries the connection (F5 recovery: a DEAD peer — broker restarted —
// is detected, closed, and re-attached once).
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { boardDir, BoardStore } from "../store/store.js";
import { readRole } from "../cli/main.js";
import { connectBoardPeer, type BoardPeer } from "../mesh/peer.js";

export interface BoardRuntime {
  /** The board room for this session, when one is resolvable. */
  room: string | undefined;
  /** Read-only membership (observer default — see the module comment). */
  observer: boolean;
  /** The presence peer — null while connecting / failed / none. */
  peer: BoardPeer | null;
  /** Honest one-line status of the auto-join (shown in tool results). */
  peerStatus: string;
  /** The joined alias base (board.json), before room+rand suffixing. */
  aliasBase: string;
  getStore(room?: string): BoardStore;
  /**
   * (Re)attach the peer when needed: no-op when a LIVE peer exists, no
   * room is joined, or the session is observer-only; a DEAD peer (F5:
   * broker restarted mid-session) is closed and re-attached once per
   * call — bounded recovery, never a retry loop.
   */
  ensurePeer(): Promise<void>;
  close(): Promise<void>;
}

/** Room for the session: $PI_BOARD_ROOM > the config saved by `piboard
 *  join`. A corrupt config degrades to no auto-join (honest store-only);
 * explicit tool params override per call (never here). */
export function sessionRoom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.PI_BOARD_ROOM;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const read = readRole(env);
  return read.state === "valid" ? read.role.room : undefined;
}

/** Observer resolution, fail-safe ordered: env-forced observer wins;
 * else the explicit config; else (no config at all) OBSERVER — the
 * v0.2 default. There is no path to member without an explicit
 * member-join config. */
export function sessionObserver(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_BOARD_OBSERVER === "true") return true;
  const read = readRole(env);
  if (read.state === "valid") return read.role.observer;
  return true;
}

/** Per-session peer alias: the joined alias + the ROOM + a short random
 * suffix, so the sender name says which board speaks (`board-muse-b636`)
 * and N sessions on one machine never collide on strictAlias. Mesh alias
 * rules forbid brackets — the alias carries the room hyphenated. */
export function sessionPeerAlias(base: string, room: string, suffix: string): string {
  const prefix = `${base}-${room}`.slice(0, 26); // ≤32 total with the -<rand4> suffix
  return `${prefix}-${suffix}`;
}

function randAliasSuffix(): string {
  return randomBytes(2).toString("hex");
}

interface AttachEnv {
  runtimeDir?: string;
}

async function attachPeer(rt: BoardRuntime, env: NodeJS.ProcessEnv, attach: AttachEnv): Promise<void> {
  const room = rt.room;
  if (room === undefined) return;
  // $MESH_RUNTIME_DIR (pi-mesh's own knob) scopes the attach to a test
  // broker; unset = the machine's default runtime dir
  const runtimeDir = attach.runtimeDir ?? (env.MESH_RUNTIME_DIR !== undefined && env.MESH_RUNTIME_DIR !== "" ? env.MESH_RUNTIME_DIR : undefined);
  // no broker listening → store-only, and NEVER spawn one: probe the
  // socket (a mesh broker keeps its local unix socket up even when it
  // also listens on tcp), then keep auto-spawn off for the connect window
  const { brokerSocketPath } = await import("pi-mesh-extension/dist/src/shared/paths.js");
  const sock = brokerSocketPath(runtimeDir, env);
  if (!existsSync(sock)) {
    rt.peerStatus = `no broker at ${sock} — store-only mode (the board never spawns a broker)`;
    return;
  }
  const saved = env.MESH_NO_AUTO_BROKER;
  env.MESH_NO_AUTO_BROKER = "1";
  try {
    const peer = await connectBoardPeer({
      room,
      observer: rt.observer,
      alias: sessionPeerAlias(env.PI_BOARD_ALIAS ?? rt.aliasBase ?? "board", room, randAliasSuffix()),
      noReconnect: true, // bounded: a failed connect must never leave a retrying client behind
      ...(runtimeDir !== undefined ? { runtimeDir } : {}),
    });
    rt.peer = peer;
    rt.peerStatus = `auto-joined ${room} as ${rt.observer ? "observer" : "member"} (presence only — the join daemon announces)`;
  } catch (err) {
    rt.peerStatus = `auto-join failed (${err instanceof Error ? err.message : String(err)}) — store-only mode`;
  } finally {
    if (saved === undefined) delete env.MESH_NO_AUTO_BROKER;
    else env.MESH_NO_AUTO_BROKER = saved;
  }
}

/**
 * Build the runtime SYNCHRONOUSLY in store-only form (cheap, fs-only)
 * and start the background peer attach. Tools are usable the instant
 * this returns — the availability contract.
 */
export function buildBoardRuntime(env: NodeJS.ProcessEnv = process.env): BoardRuntime {
  const room = sessionRoom(env);
  const observer = sessionObserver(env);
  const read = readRole(env);
  const aliasBase = read.state === "valid" ? read.role.alias : "board";

  const stores = new Map<string, BoardStore>();
  let attachBusy = false;
  const rt: BoardRuntime = {
    room,
    observer,
    aliasBase,
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
        store = new BoardStore(boardDir(target, env));
        stores.set(target, store);
      }
      return store;
    },
    ensurePeer: async () => {
      if (attachBusy) return;
      if (rt.room === undefined || rt.observer) return; // nothing to ensure for observers
      if (rt.peer !== null) {
        if (rt.peer.client.isOnline()) return;
        // F5: the broker restarted — the peer object is dead weight.
        // Close it and fall through to one re-attach.
        await rt.peer.close().catch(() => {});
        rt.peer = null;
        rt.peerStatus = "peer lost (broker restart?) — re-attaching…";
      }
      attachBusy = true;
      try {
        await attachPeer(rt, env, {});
      } finally {
        attachBusy = false;
      }
    },
    close: async () => {
      if (rt.peer !== null) await rt.peer.close().catch(() => {});
    },
  };
  if (room !== undefined) {
    attachBusy = true; // the background attempt owns the slot until done
    void attachPeer(rt, env, {})
      .catch(() => {})
      .finally(() => {
        attachBusy = false;
      });
  }
  return rt;
}
