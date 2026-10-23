// test/gates.test.ts — task_0006: the board's own write gate, semantics
// mirrored from pi-mesh routeMsg (membership before observer role).
// Unit-level by design: the gate is PRE-broker defense in depth and must
// hold without any broker (the broker-side counterpart is proven in
// mesh-join.test.ts against a real broker). Plus faf386e-style ORDER
// discrimination cases pinning where the board gate ends and broker
// policy begins: membership → observer → (rate) → policy.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { checkWriteGate, gateRefusalText, guardWrite } from "../src/mesh/gates.js";
import { connectBoardPeer, type BoardPeer } from "../src/mesh/peer.js";

function fakePeer(observer: boolean, room = "boardroom"): BoardPeer {
  return {
    alias: "board",
    room,
    observer,
    client: {} as BoardPeer["client"],
    close: async () => {},
  };
}

describe("task_0006: write gate decisions", () => {
  it("member write passes", () => {
    assert.deepEqual(checkWriteGate({ observer: false, room: "boardroom" }), { ok: true });
  });

  it("observer write is refused with a readable reason", () => {
    const d = checkWriteGate({ observer: true, room: "boardroom" });
    assert.ok(!d.ok);
    assert.equal(d.reason, "observer_readonly");
    assert.ok(d.detail.length > 10, "detail must be human-readable, not a bare code");
    const text = gateRefusalText(d);
    assert.match(text, /blocked: observer_readonly — /);
  });

  it("a write aimed outside the board's room is refused not_a_member", () => {
    const d = checkWriteGate({ observer: false, room: "boardroom", targetRoom: "elsewhere" });
    assert.ok(!d.ok);
    assert.equal(d.reason, "not_a_member");
    assert.ok(d.detail.includes("elsewhere"));
  });

  it("membership is checked BEFORE the observer role (routeMsg order)", () => {
    // both failures apply: an observer aiming at a foreign room reports
    // not_a_member — same precedence the broker's sender checks use
    const d = checkWriteGate({ observer: true, room: "boardroom", targetRoom: "elsewhere" });
    assert.ok(!d.ok);
    assert.equal(d.reason, "not_a_member");
  });

  it("guardWrite never invokes the write when the gate refuses", async () => {
    let called = 0;
    const res = await guardWrite(fakePeer(true), async () => {
      called += 1;
      return "stored";
    });
    assert.ok(!res.ok);
    assert.equal(called, 0, "a refused write must not reach the storage kernel");
    assert.equal(res.reason, "observer_readonly");
  });

  it("guardWrite passes the value through for a member", async () => {
    let called = 0;
    const res = await guardWrite(fakePeer(false), async () => {
      called += 1;
      return "stored";
    });
    assert.ok(res.ok);
    assert.equal(res.value, "stored");
    assert.equal(called, 1);
  });
});

describe("task_0006: broker-side order discrimination (faf386e style)", () => {
  // The board gate mirrors routeMsg's FIRST two sender checks; these E2E
  // cases pin the broker's full refusal order so the mirror has a provable
  // counterpart: membership → observer → (rate) → policy. A deny-all
  // policy is loaded so every case COULD also be policy_denied — which one
  // the broker reports is the assertion.
  async function withDeniedRoom(fn: (room: string, runtimeDir: string) => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "pi-board-order-"));
    const runtimeDir = path.join(root, "run");
    mkdirSync(runtimeDir, { recursive: true });
    const brokerMod = await import("pi-mesh-extension/dist/src/broker/broker.js");
    const { DEFAULT_CONFIG } = await import("pi-mesh-extension/dist/src/shared/config.js");
    const { DEFAULT_POLICY } = await import("pi-mesh-extension/dist/src/broker/policy.js");
    const broker = await brokerMod.createBroker({
      socketPath: path.join(runtimeDir, "broker.sock"),
      config: DEFAULT_CONFIG,
      policy: { ...DEFAULT_POLICY, deny: [{ from: "*", to: "*", room: "*" }] },
      stateDir: path.join(root, "state"),
    });
    try {
      await fn("boardroom", runtimeDir);
    } finally {
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("non-member beats policy: not_member is reported, not policy_denied", async () => {
    await withDeniedRoom(async (room, runtimeDir) => {
      const outsider = await connectBoardPeer({ room: "elsewhere", alias: "board-out", runtimeDir });
      try {
        const res = await outsider.client.send({ room, broadcast: true, message: "x" });
        assert.equal(res.status, "blocked");
        assert.equal(res.reason, "not_member");
      } finally {
        await outsider.close();
      }
    });
  });

  it("observer beats policy: observer_readonly is reported, not policy_denied", async () => {
    await withDeniedRoom(async (room, runtimeDir) => {
      const obs = await connectBoardPeer({ room, observer: true, alias: "board-obs2", runtimeDir });
      try {
        const res = await obs.client.send({ room, broadcast: true, message: "x" });
        assert.equal(res.status, "blocked");
        assert.equal(res.reason, "observer_readonly");
      } finally {
        await obs.close();
      }
    });
  });

  it("a member with no gate failure lands ON policy: policy_denied is reachable", async () => {
    await withDeniedRoom(async (room, runtimeDir) => {
      const member = await connectBoardPeer({ room, alias: "board-member", runtimeDir });
      const mate = await connectBoardPeer({ room, alias: "board-mate", runtimeDir });
      try {
        const res = await member.client.send({ room, broadcast: true, message: "x" });
        assert.equal(res.status, "blocked");
        assert.equal(res.reason, "policy_denied");
      } finally {
        await member.close();
        await mate.close();
      }
    });
  });
});
