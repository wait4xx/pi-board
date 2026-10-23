// test/extension.test.ts — the native extension slice: tool registration,
// honest store-only mode, gate refusal, forbidden keys, and the AUTO-JOIN
// lifecycle on a REAL broker (the mesh-join.test.ts pattern: hermetic tmp
// runtime dir, real sockets). Lifecycle hygiene: every test that fires
// session_start also fires session_shutdown and settles — a leaked peer
// socket would hang the test runner (open handles never drain).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import boardExtension from "../src/extension/index.js";
import type { ExtensionAPI, ToolDefinition } from "../src/extension/pi-types.js";
import { sessionRoom } from "../src/extension/runtime.js";

/** Capturing fake host: records registered tools + event handlers. */
function fakeApi(): {
  api: ExtensionAPI;
  tools: ToolDefinition[];
  fire(event: "session_start" | "session_shutdown"): void;
} {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, () => void | Promise<void>>();
  const api: ExtensionAPI = {
    registerTool: (tool) => tools.push(tool),
    on: (event, handler) => handlers.set(event, handler as () => void),
  };
  return { api, tools, fire: (event) => void handlers.get(event)?.() };
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool !== undefined, `tool ${name} registered`);
  return tool;
}

async function exec(tool: ToolDefinition, params: Record<string, unknown>): Promise<string> {
  const res = await tool.execute("call-1", params, new AbortController().signal, () => {}, null);
  return res.content[0]?.text ?? "";
}

const ENV_KEYS = [
  "PI_BOARD_STATE_DIR",
  "PI_BOARD_ROOM",
  "PI_BOARD_ALIAS",
  "PI_BOARD_OBSERVER",
  "PI_BOARD_AUTHOR",
  "PI_BOARD_RUNTIME_DIR",
];

function envGuard(...keys: string[]): { set(key: string, value: string | undefined): void; restore(): void } {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) saved.set(key, process.env[key]);
  return {
    set: (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    },
    restore: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function tmpStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-board-ext-"));
}

/** Boot the extension for a test AND tear it down cleanly. */
async function withExtension(
  fn: (ctx: { tools: ToolDefinition[]; exec: typeof exec }) => Promise<void>,
): Promise<void> {
  const { api, tools, fire } = fakeApi();
  boardExtension(api);
  fire("session_start");
  await new Promise((r) => setTimeout(r, 400)); // async runtime build + peer connect
  try {
    await fn({ tools, exec });
  } finally {
    fire("session_shutdown");
    await new Promise((r) => setTimeout(r, 300)); // peer sockets drain
  }
}

describe("native extension: registration + store-only behavior", () => {
  it("registers the four board tools, immediately", () => {
    const { api, tools } = fakeApi();
    boardExtension(api);
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["board_grep", "board_read", "board_watch", "board_write"],
    );
  });

  it("AVAILABILITY (review regression): tools answer IMMEDIATELY after session_start — reads never wait on the peer", async () => {
    if (process.platform === "win32") {
      // the impossible-runtime trick below is POSIX-only; visible skip, never silent
      console.log("skip: POSIX-only runtime path trick (Windows parity follow-up)");
      return;
    }
    const guard = envGuard(...ENV_KEYS);
    const root = tmpStateRoot();
    // An IMPOSSIBLE runtime dir (a path under a FILE): mkdirSync fails →
    // ensureBroker throws fast → the attach fails WITHOUT auto-spawning a
    // broker (an empty dir would spawn one — ensureBroker's job — and leak a
    // detached broker + live sockets into the test run).
    guard.set("PI_BOARD_STATE_DIR", root);
    guard.set("PI_BOARD_ROOM", "slow-room");
    guard.set("PI_BOARD_RUNTIME_DIR", "/dev/null/impossible-broker-dir");
    try {
      const { api, tools, fire } = fakeApi();
      boardExtension(api);
      fire("session_start"); // NO settle delay — the runtime must already be usable
      const w = await exec(toolByName(tools, "board_write"), { type: "FACT", text: "immediate availability" });
      assert.match(w, /^b\d+ FACT .*: immediate availability/); // NOT "not ready"
      assert.ok(!w.includes("not ready"));
      const r = await exec(toolByName(tools, "board_read"), {});
      assert.ok(r.includes("immediate availability"));
      // drain the failed background attach + session teardown
      fire("session_shutdown");
      await new Promise((r2) => setTimeout(r2, 300));
    } finally {
      guard.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("board_write → board_read → board_grep with an explicit room (no join needed)", async () => {
    const guard = envGuard(...ENV_KEYS);
    const root = tmpStateRoot();
    guard.set("PI_BOARD_STATE_DIR", root);
    guard.set("PI_BOARD_AUTHOR", "ext-tester");
    try {
      await withExtension(async ({ tools, exec }) => {
        const w = await exec(toolByName(tools, "board_write"), { room: "r1", type: "FAIL", text: "approach X falsified: EBUSY" });
        assert.match(w, /^b\d+ FAIL ext-tester: approach X falsified: EBUSY/);
        assert.ok(w.includes("store-only")); // honest degraded mode

        const r = await exec(toolByName(tools, "board_read"), { room: "r1" });
        assert.ok(r.includes("EBUSY"));

        const g = await exec(toolByName(tools, "board_grep"), { room: "r1", query: "ebusy" });
        assert.match(g, /FAIL ext-tester: approach X falsified: EBUSY/);

        const miss = await exec(toolByName(tools, "board_grep"), { room: "r1", query: "nothing" });
        assert.equal(miss, "(no match)"); // honest empty

        const watch = await exec(toolByName(tools, "board_watch"), { room: "r1" });
        assert.match(watch, /1 new FAIL/);
      });
    } finally {
      guard.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("observer config: board_write is refused by the gate, reads unaffected", async () => {
    const guard = envGuard(...ENV_KEYS);
    const root = tmpStateRoot();
    // runtimeDir points at an EMPTY dir: no broker → the auto-join fails
    // fast and honestly (peer null), the gate still refuses from config.
    const emptyRuntime = mkdtempSync(path.join(tmpdir(), "pi-board-nobroker-"));
    guard.set("PI_BOARD_STATE_DIR", root);
    guard.set("PI_BOARD_ROOM", "obs-room");
    guard.set("PI_BOARD_RUNTIME_DIR", emptyRuntime);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "board.json"), JSON.stringify({ room: "obs-room", observer: true, alias: "board" }), "utf8");
    try {
      await withExtension(async ({ tools, exec }) => {
        const w = await exec(toolByName(tools, "board_write"), { type: "FACT", text: "must be refused" });
        assert.match(w, /observer_readonly/);
        const r = await exec(toolByName(tools, "board_read"), {});
        assert.ok(r.includes("empty"));
      });
    } finally {
      guard.restore();
      rmSync(root, { recursive: true, force: true });
      rmSync(emptyRuntime, { recursive: true, force: true });
    }
  });

  it("forbidden keys refuse the append with the honest error", async () => {
    const guard = envGuard(...ENV_KEYS);
    const root = tmpStateRoot();
    guard.set("PI_BOARD_STATE_DIR", root);
    try {
      await withExtension(async ({ tools, exec }) => {
        const w = await exec(toolByName(tools, "board_write"), { room: "r1", type: "FACT", text: "token ghp_ABCDEFGHIJKLMNOPQRST leaked" });
        assert.match(w, /forbidden_key/);
      });
    } finally {
      guard.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sessionRoom: env wins over config; unreadable config degrades honestly", () => {
    const guard = envGuard("PI_BOARD_STATE_DIR", "PI_BOARD_ROOM");
    const root = tmpStateRoot();
    guard.set("PI_BOARD_STATE_DIR", root);
    try {
      assert.equal(sessionRoom({ ...process.env, PI_BOARD_ROOM: "env-room" } as NodeJS.ProcessEnv), "env-room");
      mkdirSync(root, { recursive: true });
      writeFileSync(path.join(root, "board.json"), "NOT JSON", "utf8");
      assert.equal(sessionRoom(process.env), undefined); // degraded, not a crash
    } finally {
      guard.restore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("native extension: AUTO-JOIN on a real broker", () => {
  it("session_start auto-joins the joined room; writes announce to the room; shutdown closes the peer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-board-autojoin-"));
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
    const guard = envGuard(...ENV_KEYS);
    guard.set("PI_BOARD_STATE_DIR", path.join(root, "board-state"));
    guard.set("PI_BOARD_ROOM", "zoma");
    guard.set("PI_BOARD_RUNTIME_DIR", runtimeDir);
    guard.set("PI_BOARD_AUTHOR", "autojoin-test");
    const { MeshClient } = await import("pi-mesh-extension/dist/src/client/client.js");
    const witness = new MeshClient({ alias: "witness", rooms: ["zoma"], runtimeDir });
    const received: string[] = [];
    await witness.connect();
    witness.on("inbound", (frame: { type?: string; body?: string }) => {
      if (frame.type === "msg") received.push(frame.body ?? "");
    });
    try {
      await withExtension(async ({ tools, exec }) => {
        const w = await exec(toolByName(tools, "board_write"), { type: "FACT", text: "autojoin announcement works" });
        assert.match(w, /^b\d+ FACT autojoin-test: autojoin announcement works/);
        assert.ok(!w.includes("store-only"), `expected a live announce, got: ${w}`);
        const deadline = Date.now() + 5_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.match(received[0] ?? "", /board\[zoma\] FACT b\d+: autojoin announcement works/);
      });
    } finally {
      guard.restore();
      await witness.close().catch(() => {});
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
