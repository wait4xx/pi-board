// test/availability.test.ts — task_0002: the availability contract —
// tools answer immediately, a down/slow broker never blocks the session,
// the attach is bounded, and no broker is ever spawned (probe-first).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "../src/extension/pi-types.js";
import boardExtension from "../src/extension/index.js";
import type { BoardRuntime } from "../src/extension/runtime.js";

const ROOM = "avail";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function session(rt: BoardRuntime): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, () => void>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
    on: (event: string, fn: () => void) => handlers.set(event, fn),
  } as unknown as ExtensionAPI;
  boardExtension(pi, { runtime: () => rt });
  handlers.get("session_start")?.();
  return tools;
}

function hermeticEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PI_BOARD_STATE_DIR: path.join(root, "state"),
    MESH_RUNTIME_DIR: path.join(root, "run"),
    ...extra,
  };
  delete env.MESH_NO_AUTO_BROKER; // the contract must hold WITHOUT the guard env
  return env;
}

async function withRoot(fn: (root: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-board-avail-"));
  mkdirSync(path.join(root, "run"), { recursive: true });
  mkdirSync(path.join(root, "state"), { recursive: true });
  try {
    await fn(root, hermeticEnv(root, { PI_BOARD_ROOM: ROOM }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("task_0002: availability contract", () => {
  it("tools answer IMMEDIATELY with the peer unable to attach — reads never wait", async (t) => {
    await withRoot(async (_root, env) => {
      // NO broker anywhere in run/ — the attach can only fail/store-only
      const started = Date.now();
      const { buildBoardRuntime } = await import("../src/extension/runtime.js");
      const rt = buildBoardRuntime(env);
      t.after(() => rt.close());
      const tools = session(rt);
      const buildMs = Date.now() - started;
      assert.ok(buildMs < 250, `store-only build must be cheap, took ${buildMs}ms`);

      const t0 = Date.now();
      const read = (await tools.get("board_read")!.execute("c", { room: ROOM }, undefined, undefined, undefined)) as {
        content: { text: string }[];
      };
      const readMs = Date.now() - t0;
      assert.ok(readMs < 250, `explicit-room read must not wait on the peer, took ${readMs}ms`);
      assert.match(read.content[0]!.text, /empty/);
    });
  });

  it("session_start is synchronous: tools answer while the peer is still 'connecting…'", async (t) => {
    await withRoot(async (_root, env) => {
      const { buildBoardRuntime } = await import("../src/extension/runtime.js");
      const rt = buildBoardRuntime(env);
      t.after(() => rt.close());
      // buildBoardRuntime returned WITHOUT waiting for the attach — the
      // status may still be connecting and tools already work
      assert.ok(["connecting…", "no broker", "store-only"].some((s) => rt.peerStatus.startsWith(s) || rt.peerStatus.includes(s)));
      const tools = session(rt);
      const grep = (await tools.get("board_grep")!.execute("c", { query: "x", room: ROOM }, undefined, undefined, undefined)) as {
        content: { text: string }[];
      };
      assert.match(grep.content[0]!.text, /\(no match\)/);
    });
  });

  it("bounded attach: a broker-less dir settles to store-only ONCE — no retries, no spawned broker", async (t) => {
    await withRoot(async (root, env) => {
      const { buildBoardRuntime } = await import("../src/extension/runtime.js");
      const rt = buildBoardRuntime(env);
      t.after(() => rt.close());
      await sleep(600); // let the background attempt settle
      assert.match(rt.peerStatus, /store-only/);
      await sleep(600); // and it STAYS settled — no retry storm
      assert.match(rt.peerStatus, /store-only/);
      // probe-first: even with MESH_NO_AUTO_BROKER unset, nothing spawned
      assert.equal(existsSync(path.join(root, "run", "broker.sock")), false);
      assert.equal(rt.peer, null);
    });
  });

  it("hermetic by construction: the suite env never leaks a broker spawn (regression for the guard)", async (t) => {
    await withRoot(async (root, env) => {
      // simulate the exact state a client auto-spawn would exploit: a
      // resolvable room, no socket, NO MESH_NO_AUTO_BROKER in env
      assert.equal(env.MESH_NO_AUTO_BROKER, undefined);
      const { buildBoardRuntime } = await import("../src/extension/runtime.js");
      const rt = buildBoardRuntime(env);
      t.after(() => rt.close());
      await sleep(400);
      assert.equal(existsSync(path.join(root, "run", "broker.sock")), false, "the board spawned a broker!");
    });
  });
});
