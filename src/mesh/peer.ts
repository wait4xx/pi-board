// src/mesh/peer.ts — the board's face as a pi-mesh peer (DESIGN §5.1).
//
// The board is a NORMAL peer: alias (default "board", PI_BOARD_ALIAS
// override), one room, member by default, --observer opts into read-only.
// No protocol special-casing, no broker changes.
//
// One upstream subtlety this wrapper must defend against (the "same class
// of bug we just fixed in ctl", pi-mesh issue #13): a MeshClient hello —
// INCLUDING the automatic re-hello after a reconnect — carries room names
// but no role, so an observer peer silently rejoins as a MEMBER. The
// broker's joinRoom does update the role on re-join, so this wrapper
// re-asserts the observer role on every (re)connect. Task_0006's own
// gates additionally refuse writes client-side regardless of what the
// broker believes — defense in depth.
import type { MeshClient } from "pi-mesh-extension/dist/src/client/client.js";
import { loadMesh } from "./deps.js";

export interface BoardPeerOpts {
  /** The single board room (DESIGN: one room in v0.1). */
  room: string;
  /** Peer alias; default "board" or $PI_BOARD_ALIAS. */
  alias?: string;
  /** Read-only membership (DESIGN §5.1 --observer). */
  observer?: boolean;
  /** Broker runtime dir override (tests / multi-broker setups). */
  runtimeDir?: string;
}

export interface BoardPeer {
  readonly alias: string;
  readonly room: string;
  readonly observer: boolean;
  /** The underlying client — later tasks (gates, notify) build on it. */
  readonly client: MeshClient;
  close(): Promise<void>;
}

/**
 * Connect the board peer. Member identity is declared at hello (rooms in
 * the client options); observer identity is APPLIED right after every
 * (re)connect via join(room, "observer") — see the module comment for why
 * re-assertion is load-bearing. strictAlias keeps a second board from
 * silently falling back to a random alias nobody can find.
 */
export async function connectBoardPeer(opts: BoardPeerOpts): Promise<BoardPeer> {
  const { MeshClient } = await loadMesh();
  const alias = opts.alias ?? process.env.PI_BOARD_ALIAS ?? "board";
  const client = new MeshClient({
    alias,
    rooms: [opts.room],
    strictAlias: true,
    ...(opts.runtimeDir !== undefined ? { runtimeDir: opts.runtimeDir } : {}),
    config: {},
  });
  const assertObserver = (): void => {
    // fire-and-forget on reconnect; a failure surfaces via the client's
    // error events — the next ready retries the assertion
    void client.join(opts.room, "observer").catch(() => {});
  };
  if (opts.observer === true) client.on("ready", assertObserver);
  await client.connect();
  if (opts.observer === true) await client.join(opts.room, "observer");
  return {
    alias,
    room: opts.room,
    observer: opts.observer === true,
    client,
    close: () => client.close(),
  };
}
