// test/extension.test.ts — task_0001: the ported native extension —
// auto-join (observer default), no-spawn, F5 recovery, store-only tools.
// Real broker where a peer attaches; hermetic env per test.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "../src/extension/pi-types.js";
import boardExtension from "../src/extension/index.js";
import {
  buildBoardRuntime,
  sessionObserver,
  sessionPeerAlias,
  sessionRoom,
  type BoardRuntime,
} from "../src/extension/runtime.js";

const ROOM = "ext";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  root: string;
  runDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  broker: { close(): Promise<void>; socketPath: string } | null;
  mates: { close(): Promise<void> }[];
  cleanup(): Promise<void>;
}

async function withCtx(setup: (c: Ctx) => Promise<void> = async () => {}): Promise<Ctx> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-board-ext-"));
  const runDir = path.join(root, "run");
  const stateDir = path.join(root, "state");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const ctx: Ctx = {
    root,
    runDir,
    stateDir,
    env: { PI_BOARD_STATE_DIR: stateDir, MESH_RUNTIME_DIR: runDir },
    broker: null,
    mates: [],
    async cleanup() {
      for (const m of this.mates) await m.close().catch(() => {});
      await this.broker?.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    },
  };
  await setup(ctx);
  return ctx;
}

async function spawnBroker(ctx: Ctx): Promise<void> {
  const brokerMod = await import("pi-mesh-extension/dist/src/broker/broker.js");
  const { DEFAULT_CONFIG } = await import("pi-mesh-extension/dist/src/shared/config.js");
  const { DEFAULT_POLICY } = await import("pi-mesh-extension/dist/src/broker/policy.js");
  ctx.broker = await brokerMod.createBroker({
    socketPath: path.join(ctx.runDir, "broker.sock"),
    config: DEFAULT_CONFIG,
    policy: DEFAULT_POLICY,
    stateDir: path.join(ctx.root, "broker-state"),
  });
}

async function addMate(ctx: Ctx, alias: string): Promise<void> {
  const { MeshClient } = await import("pi-mesh-extension/dist/src/client/client.js");
  const mate = new MeshClient({ alias, rooms: [ROOM], runtimeDir: ctx.runDir, config: {}, noReconnect: true });
  await mate.connect();
  ctx.mates.push(mate);
}

/** Wait for the background attach to settle past "connecting…". */
async function settle(rt: BoardRuntime, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!rt.peerStatus.startsWith("connecting")) return rt.peerStatus;
    await sleep(50);
  }
  return rt.peerStatus;
}

function toolsOf(rt: BoardRuntime | null): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, () => void>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
    on: (event: string, fn: () => void) => {
      handlers.set(event, fn);
    },
  } as unknown as ExtensionAPI;
  boardExtension(pi, rt !== null ? { runtime: () => rt } : {});
  // Fire session_start ONLY for an injected runtime. With rt === null the
  // handler would build a REAL runtime from process.env — on a machine with
  // a joined board config that attaches a live peer to the real mesh which
  // nothing closes: a handle leak that hangs the test process (and pollutes
  // the mesh). The null case asserts PRE-START registration — no start.
  if (rt !== null) handlers.get("session_start")?.();
  return tools;
}

function run(tool: ToolDefinition | undefined, params: Record<string, unknown>) {
  assert.ok(tool !== undefined, "tool registered");
  return tool!.execute("c", params, undefined, undefined, undefined) as Promise<{ content: { text: string }[] }>;
}

function textOf(res: { content: { text: string }[] }): string {
  return res.content[0]?.text ?? "";
}

describe("native extension: registration + store-only", () => {
  it("registers the four board tools immediately (before session_start)", () => {
    const tools = toolsOf(null);
    for (const name of ["board_write", "board_read", "board_grep", "board_watch"]) {
      assert.ok(tools.has(name), name);
    }
  });

  it("sessionRoom: env wins over config; corrupt config degrades to no auto-join", async (t) => {
    const ctx = await withCtx();
    t.after(() => ctx.cleanup());
    assert.equal(sessionRoom({ ...ctx.env, PI_BOARD_ROOM: "envroom" }), "envroom");
    assert.equal(sessionRoom(ctx.env), undefined); // absent config
    writeFileSync(path.join(ctx.stateDir, "board.json"), "{broken");
    assert.equal(sessionRoom(ctx.env), undefined); // corrupt degrades honestly
    assert.equal(sessionObserver(ctx.env), true); // and never grants member
  });

  it("sessionObserver: no config → observer (the v0.2 default); member needs the explicit config; env forces observer", async (t) => {
    const ctx = await withCtx();
    t.after(() => ctx.cleanup());
    assert.equal(sessionObserver(ctx.env), true);
    writeFileSync(
      path.join(ctx.stateDir, "board.json"),
      JSON.stringify({ room: ROOM, alias: "board-test", observer: false, watermarkMs: 0 }),
    );
    assert.equal(sessionObserver(ctx.env), false); // explicit member config
    assert.equal(sessionObserver({ ...ctx.env, PI_BOARD_OBSERVER: "true" }), true); // fail-safe override
  });

  it("sessionPeerAlias carries the room, respects the mesh alias bound", () => {
    const alias = sessionPeerAlias("board", "muse", "b636");
    assert.equal(alias, "board-muse-b636");
    assert.ok(alias.length <= 32);
    assert.ok(!alias.includes("["));
    const long = sessionPeerAlias("board", "a-very-long-room-name-here", "zz99");
    assert.ok(long.length <= 32, `got ${long.length}: ${long}`);
  });
});

describe("native extension: auto-join on a real broker", () => {
  it("no config (env room) auto-joins as OBSERVER — broker-side role asserted behaviorally", async (t) => {
    const ctx = await withCtx(async (c) => {
      await spawnBroker(c);
      await addMate(c, "mate");
    });
    t.after(() => ctx.cleanup());
    const rt = buildBoardRuntime({ ...ctx.env, PI_BOARD_ROOM: ROOM });
    t.after(() => rt.close());
    const status = await settle(rt);
    assert.match(status, /auto-joined .* as observer/);
    assert.ok(rt.peer !== null);
    // broker-side truth: the observer peer's own broadcast is refused
    const res = await rt.peer!.client.send({ room: ROOM, broadcast: true, message: "probe" });
    assert.equal(res.status, "blocked");
    assert.equal(res.reason, "observer_readonly");
  });

  it("a member config upgrades the auto-join to member (write capability)", async (t) => {
    const ctx = await withCtx(async (c) => {
      await spawnBroker(c);
      await addMate(c, "mate");
      writeFileSync(
        path.join(c.stateDir, "board.json"),
        JSON.stringify({ room: ROOM, alias: "board-test", observer: false, watermarkMs: 0 }),
      );
    });
    t.after(() => ctx.cleanup());
    const rt = buildBoardRuntime(ctx.env);
    t.after(() => rt.close());
    const status = await settle(rt);
    assert.match(status, /auto-joined .* as member/);
    const res = await rt.peer!.client.send({ room: ROOM, broadcast: true, message: "member probe" });
    assert.equal(res.status, "delivered");
  });

  it("observer sessions cannot board_write (the gate), reads still work", async (t) => {
    const ctx = await withCtx();
    t.after(() => ctx.cleanup());
    const rt = buildBoardRuntime({ ...ctx.env, PI_BOARD_ROOM: ROOM });
    t.after(() => rt.close());
    const tools = toolsOf(rt);
    const denied = await run(tools.get("board_write"), { type: "FAIL", text: "must not land" });
    assert.match(textOf(denied), /observer_readonly/);
    // explicit-room reads never wait on the peer
    const read = await run(tools.get("board_read"), { room: ROOM });
    assert.match(textOf(read), /empty/);
  });

  it("board_write appends (no announce here) and board_read/grep find it — the daemon owns broadcasts", async (t) => {
    const ctx = await withCtx(async (c) => {
      writeFileSync(
        path.join(c.stateDir, "board.json"),
        JSON.stringify({ room: ROOM, alias: "board-test", observer: false, watermarkMs: 0 }),
      );
    });
    t.after(() => ctx.cleanup());
    const rt = buildBoardRuntime(ctx.env);
    t.after(() => rt.close());
    const tools = toolsOf(rt);
    const wrote = await run(tools.get("board_write"), { type: "FAIL", text: "port falsified X" });
    assert.match(textOf(wrote), /port falsified X/);
    assert.match(textOf(wrote), /piboard join.*announces/);
    const read = await run(tools.get("board_read"), {});
    assert.match(textOf(read), /port falsified X/);
    const grep = await run(tools.get("board_grep"), { query: "port&falsified" });
    assert.match(textOf(grep), /port falsified X/);
    const watch = await run(tools.get("board_watch"), {});
    assert.match(textOf(watch), /1 new FAIL/);
  });
});

describe("native extension: no-spawn + F5 recovery", () => {
  it("a broker-less machine NEVER gets a spawned broker — store-only, honestly", async (t) => {
    const ctx = await withCtx(); // no broker spawned
    t.after(() => ctx.cleanup());
    const rt = buildBoardRuntime({ ...ctx.env, PI_BOARD_ROOM: ROOM });
    t.after(() => rt.close());
    const status = await settle(rt);
    assert.match(status, /store-only/);
    assert.equal(existsSync(path.join(ctx.runDir, "broker.sock")), false, "a broker socket appeared!");
  });

  it("session lifecycle: shutdown closes the auto-joined peer (no leaked handles)", async (t) => {
    const ctx = await withCtx(async (c) => {
      await spawnBroker(c);
      await addMate(c, "mate");
    });
    t.after(() => ctx.cleanup());
    // drive the REAL entrypoint lifecycle in production shape (runtime from
    // process.env, scoped to this test's broker). A discarded runtime that
    // leaves a live peer hangs the process — the leak this test guards was
    // real on any machine with a joined board config + live broker.
    const handlers = new Map<string, () => void>();
    const pi = {
      registerTool: () => {},
      on: (event: string, fn: () => void) => handlers.set(event, fn),
    } as unknown as ExtensionAPI;
    const saved: [string, string | undefined][] = [
      ["PI_BOARD_STATE_DIR", process.env.PI_BOARD_STATE_DIR],
      ["MESH_RUNTIME_DIR", process.env.MESH_RUNTIME_DIR],
      ["PI_BOARD_ROOM", process.env.PI_BOARD_ROOM],
    ];
    process.env.PI_BOARD_STATE_DIR = ctx.stateDir;
    process.env.MESH_RUNTIME_DIR = ctx.runDir;
    process.env.PI_BOARD_ROOM = ROOM;
    const mate = ctx.mates[0] as unknown as { status(): Promise<{ peers?: { alias?: string }[] }> };
    const boardPeerPresent = async (): Promise<boolean> => {
      const snap = await mate.status();
      return (snap.peers ?? []).some((p) => (p.alias ?? "").startsWith(`board-${ROOM}`));
    };
    try {
      boardExtension(pi, {});
      handlers.get("session_start")?.();
      const joined = await (async () => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (await boardPeerPresent()) return true;
          await sleep(100);
        }
        return false;
      })();
      assert.ok(joined, "auto-join peer never appeared in the room snapshot");
      handlers.get("session_shutdown")?.();
      const gone = await (async () => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (!(await boardPeerPresent())) return true;
          await sleep(100);
        }
        return false;
      })();
      assert.ok(gone, "shutdown left the auto-joined peer in the room — handle leak");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("F5: a dead peer (broker restart) is detected and re-attached by ensurePeer", async (t) => {
    const ctx = await withCtx(async (c) => {
      writeFileSync(
        path.join(c.stateDir, "board.json"),
        JSON.stringify({ room: ROOM, alias: "board-test", observer: false, watermarkMs: 0 }),
      );
    });
    t.after(() => ctx.cleanup());
    // first life: broker up, member attach
    await spawnBroker(ctx);
    await addMate(ctx, "mate");
    const rt = buildBoardRuntime(ctx.env);
    t.after(() => rt.close());
    await settle(rt);
    assert.equal(rt.peer?.client.isOnline(), true);
    // broker dies; the bounded peer goes offline (no reconnect loop)
    await ctx.broker!.close();
    ctx.broker = null;
    await sleep(400);
    assert.equal(rt.peer?.client.isOnline(), false);
    // broker comes back on the same socket; ensurePeer recovers ONCE
    await spawnBroker(ctx);
    await addMate(ctx, "mate2");
    await rt.ensurePeer();
    assert.ok(rt.peer !== null, "peer re-attached");
    assert.equal(rt.peer.client.isOnline(), true);
    const res = await rt.peer.client.send({ room: ROOM, broadcast: true, message: "recovered" });
    assert.equal(res.status, "delivered");
  });
});
