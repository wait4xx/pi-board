// test/mesh-join.test.ts — task_0005: the board as a mesh peer (E2E on a
// REAL broker + REAL unix sockets, spike-verified dependency face).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { connectBoardPeer, type BoardPeer } from "../src/mesh/peer.js";
import { PEER_MISSING_MESSAGE, loadMesh } from "../src/mesh/deps.js";

interface Ctx {
  root: string;
  runtimeDir: string;
  socketPath: string;
  broker: { close: () => Promise<void> };
  peers: BoardPeer[];
  cleanup: () => Promise<void>;
}

/** Real broker per test (hermetic tmp dirs). createBroker requires explicit
 *  config AND policy (no internal defaults — spike finding) and does NOT
 *  create the socket's parent directory (spike finding). */
async function withCtx(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-board-join-"));
  const runtimeDir = path.join(root, "run");
  const stateDir = path.join(root, "state");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const brokerMod = await import("pi-mesh-extension/dist/src/broker/broker.js");
  const { DEFAULT_CONFIG } = await import("pi-mesh-extension/dist/src/shared/config.js");
  const { DEFAULT_POLICY } = await import("pi-mesh-extension/dist/src/broker/policy.js");
  const broker = await brokerMod.createBroker({
    socketPath: path.join(runtimeDir, "broker.sock"),
    config: DEFAULT_CONFIG,
    policy: DEFAULT_POLICY,
    stateDir,
  });
  const peers: BoardPeer[] = [];
  const ctx: Ctx = {
    root,
    runtimeDir,
    socketPath: path.join(runtimeDir, "broker.sock"),
    broker,
    peers,
    cleanup: async () => {
      for (const p of peers) await p.close().catch(() => {});
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  try {
    await fn(ctx);
  } finally {
    await ctx.cleanup();
  }
}

/** Force an INVOLUNTARY disconnect (the reconnect path, not a user close).
 *  Socket access is private upstream; tests may reach in — production code
 *  never does. */
function killSocket(peer: BoardPeer): void {
  (peer.client as unknown as { socket: { destroy(): void } | null }).socket?.destroy();
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("task_0005: board peer join", () => {
  it("joins as a member: alias defaults to 'board', room at hello, writes pass", async () => {
    await withCtx(async ({ peers, runtimeDir }) => {
      const board = await connectBoardPeer({  room: "boardroom", runtimeDir });
      peers.push(board);
      // a broadcast needs another room member to land on (the broker refuses
      // a room of one with peer_not_found — honest, not a board bug)
      const other = await connectBoardPeer({  room: "boardroom", alias: "board-mate", runtimeDir });
      peers.push(other);
      assert.equal(board.alias, "board");
      assert.equal(board.observer, false);
      assert.ok(board.client.rooms.includes("boardroom"));
      const res = await board.client.send({
        room: "boardroom",
        broadcast: true,
        message: "member check",
      });
      assert.equal(res.status, "delivered");
    });
  });

  it("honors PI_BOARD_ALIAS and an explicit alias", async () => {
    await withCtx(async ({ peers, runtimeDir }) => {
      const saved = process.env.PI_BOARD_ALIAS;
      try {
        process.env.PI_BOARD_ALIAS = "envboard";
        const viaEnv = await connectBoardPeer({  room: "boardroom", runtimeDir });
        peers.push(viaEnv);
        assert.equal(viaEnv.alias, "envboard");
        const explicit = await connectBoardPeer({  room: "boardroom", alias: "explicit-board", runtimeDir });
        peers.push(explicit);
        assert.equal(explicit.alias, "explicit-board");
      } finally {
        if (saved === undefined) delete process.env.PI_BOARD_ALIAS;
        else process.env.PI_BOARD_ALIAS = saved;
      }
    });
  });

  it("observer identity is real at the broker: writes refused observer_readonly", async () => {
    await withCtx(async ({ peers, runtimeDir }) => {
      const obs = await connectBoardPeer({  room: "boardroom", observer: true, runtimeDir });
      peers.push(obs);
      assert.equal(obs.observer, true);
      const res = await obs.client.send({
        room: "boardroom",
        broadcast: true,
        message: "must be refused",
      });
      assert.equal(res.status, "blocked");
      assert.equal(res.reason, "observer_readonly");
    });
  });

  it("reconnect: a member peer rejoins and keeps receiving broadcasts", async () => {
    await withCtx(async ({ peers, runtimeDir }) => {
      const board = await connectBoardPeer({  room: "boardroom", runtimeDir });
      peers.push(board);
      const watcher = await connectBoardPeer({  room: "boardroom", alias: "board-watch", runtimeDir });
      peers.push(watcher);
      killSocket(board);
      const back = await waitUntil(async () => {
        const res = await board.client
          .send({ room: "boardroom", broadcast: true, message: "after reconnect" })
          .catch(() => ({ status: "error", reason: "down" }));
        return res.status === "delivered";
      });
      assert.ok(back, "member peer did not come back as a writer after reconnect");
    });
  });

  it("reconnect: an observer peer re-asserts the read-only role (the ctl bug class)", async () => {
    await withCtx(async ({ peers, runtimeDir }) => {
      const obs = await connectBoardPeer({  room: "boardroom", observer: true, alias: "board-obs", runtimeDir });
      peers.push(obs);
      killSocket(obs);
      // after the automatic re-hello the peer is member again at the broker
      // until the re-assert join lands — the invariant is "refused again
      // and STAYS refused", so poll for the refusal
      const refused = await waitUntil(async () => {
        const res = await obs.client
          .send({ room: "boardroom", broadcast: true, message: "still read-only" })
          .catch(() => ({ status: "error", reason: "down" }));
        return res.status === "blocked" && res.reason === "observer_readonly";
      });
      assert.ok(refused, "observer role was not re-asserted after reconnect");
      // and it must STAY refused (no flapping back to member)
      await new Promise((r) => setTimeout(r, 600));
      const again = await obs.client.send({
        room: "boardroom",
        broadcast: true,
        message: "still read-only 2",
      });
      assert.equal(again.status, "blocked");
      assert.equal(again.reason, "observer_readonly");
    });
  });

  it("strictAlias: a second board with the same alias is an honest error", async () => {
    await withCtx(async ({ peers, runtimeDir }) => {
      const first = await connectBoardPeer({  room: "boardroom", runtimeDir });
      peers.push(first);
      await assert.rejects(
        () => connectBoardPeer({  room: "boardroom", runtimeDir }),
        (err: unknown) => err instanceof Error && /alias_taken|alias/i.test(err.message),
      );
    });
  });

  it("dependency face: loadMesh resolves the client core (or reports the missing peer honestly)", async () => {
    const mod = await loadMesh();
    assert.equal(typeof mod.MeshClient, "function");
    assert.ok(PEER_MISSING_MESSAGE.includes("pi-mesh-extension"));
  });
});
