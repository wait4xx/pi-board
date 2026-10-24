// test/notify.test.ts — task_0007: one normal broadcast per write, the
// turn-boundary FAIL summary line. E2E on a real broker where frames are
// observed; unit level for the summary selection/formatting.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { MeshFrame } from "pi-mesh-extension/dist/src/protocol/envelope.js";
import { connectBoardPeer, type BoardPeer } from "../src/mesh/peer.js";
import {
  announceWrite,
  broadcastBody,
  failSummaryLine,
  selectNewFails,
  type NotifiableEntry,
} from "../src/mesh/notify.js";

const ENTRY: NotifiableEntry = {
  id: "e_0001",
  type: "FAIL",
  room: "boardroom",
  short: "retry-with-backoff falsified: 3/3 timeouts under load",
  at: new Date("2026-10-23T10:00:00Z").toISOString(),
};

async function withRoom(
  observer: boolean,
  fn: (board: BoardPeer, watcher: BoardPeer) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-board-notify-"));
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
  try {
    const board = await connectBoardPeer({
      room: "boardroom",
      observer,
      runtimeDir,
      ...(observer ? { alias: "board-obs" } : {}),
    });
    peers.push(board);
    const watcher = await connectBoardPeer({ room: "boardroom", alias: "board-watch", runtimeDir });
    peers.push(watcher);
    await fn(board, watcher);
  } finally {
    for (const p of peers) await p.close().catch(() => {});
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function nextBroadcast(watcher: BoardPeer, timeoutMs = 4000): Promise<MeshFrame | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      watcher.client.removeListener("inbound", on);
      resolve(null);
    }, timeoutMs);
    const on = (f: MeshFrame) => {
      if (f.broadcast === true) {
        clearTimeout(t);
        watcher.client.removeListener("inbound", on);
        resolve(f);
      }
    };
    watcher.client.on("inbound", on);
  });
}

describe("task_0007: write announcement (E2E)", () => {
  it("a member write emits ONE normal-priority broadcast with type+id+short", async () => {
    await withRoom(false, async (board, watcher) => {
      const got = nextBroadcast(watcher);
      const res = await announceWrite(board, ENTRY);
      assert.equal(res.ok, true);
      const f = await got;
      assert.ok(f !== null, "watcher never saw the broadcast");
      assert.equal(f.room, "boardroom");
      assert.equal(f.body, broadcastBody(ENTRY));
      assert.match(f.body ?? "", /board\[boardroom\] FAIL e_0001: /);
      // constraint #5: normal priority — never urgent/force escalation
      assert.notEqual(f.priority, "urgent");
      assert.notEqual(f.priority, "force");
    });
  });

  it("the body is bounded and carries no detail-sized payload", async () => {
    const long: NotifiableEntry = { ...ENTRY, short: "x".repeat(2_000) };
    const body = broadcastBody(long);
    assert.ok(body.length <= 500, `body must stay skimmable, got ${body.length}`);
    assert.ok(body.endsWith("…"));
  });

  it("an observer board announces nothing (gate refuses before the broker)", async () => {
    await withRoom(true, async (board, watcher) => {
      const got = nextBroadcast(watcher, 1_200);
      const res = await announceWrite(board, ENTRY);
      assert.ok(!res.ok);
      assert.equal(res.reason, "observer_readonly");
      assert.equal(await got, null, "no frame may escape an observer board");
    });
  });

  it("an empty room is reported honestly (peer_not_found), not silently dropped", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-board-solo-"));
    const runtimeDir = path.join(root, "run");
    mkdirSync(runtimeDir, { recursive: true });
    const brokerMod = await import("pi-mesh-extension/dist/src/broker/broker.js");
    const { DEFAULT_CONFIG } = await import("pi-mesh-extension/dist/src/shared/config.js");
    const { DEFAULT_POLICY } = await import("pi-mesh-extension/dist/src/broker/policy.js");
    const broker = await brokerMod.createBroker({
      socketPath: path.join(runtimeDir, "broker.sock"),
      config: DEFAULT_CONFIG,
      policy: DEFAULT_POLICY,
      stateDir: path.join(root, "state"),
    });
    try {
      const solo = await connectBoardPeer({ room: "emptyroom", runtimeDir });
      const res = await announceWrite(solo, ENTRY);
      assert.ok(!res.ok);
      assert.equal(res.status, "blocked");
      assert.equal(res.reason, "peer_not_found");
      await solo.close();
    } finally {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("task_0007: FAIL summary line (unit)", () => {
  const fails: NotifiableEntry[] = [
    { id: "e_1", type: "FAIL", room: "boardroom", short: "first falsified path", at: "2026-10-23T10:00:01Z" },
    { id: "e_2", type: "FAIL", room: "boardroom", short: "second falsified path", at: "2026-10-23T10:00:02Z" },
    { id: "e_3", type: "OBSERVED", room: "boardroom", short: "not a fail", at: "2026-10-23T10:00:03Z" },
    { id: "e_0", type: "FAIL", room: "boardroom", short: "before the boundary", at: "2026-10-23T09:00:00Z" },
  ];

  it("selects only FAIL entries newer than the boundary, oldest first", () => {
    const since = Date.parse("2026-10-23T10:00:00Z");
    const sel = selectNewFails(fails, since);
    assert.deepEqual(sel.map((e) => e.id), ["e_1", "e_2"]);
  });

  it("renders one skimmable bounded line; nothing new renders nothing", () => {
    const line = failSummaryLine(selectNewFails(fails, Date.parse("2026-10-23T10:00:00Z")));
    assert.match(line, /^⚠ board\[boardroom\]: 2 new FAIL — e_1:first falsified path \| e_2:/);
    assert.ok(line.length <= 400);
    assert.equal(failSummaryLine([]), "");
    assert.equal(failSummaryLine(selectNewFails(fails, Date.parse("2026-10-23T11:00:00Z"))), "");
  });
});
