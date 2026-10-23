// test/gates.test.ts — task_0006: the board's own write gate, semantics
// mirrored from pi-mesh routeMsg (membership before observer role).
// Unit-level by design: the gate is PRE-broker defense in depth and must
// hold without any broker (the broker-side counterpart is proven in
// mesh-join.test.ts against a real broker).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkWriteGate, gateRefusalText, guardWrite } from "../src/mesh/gates.js";
import type { BoardPeer } from "../src/mesh/peer.js";

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
