// test/session-rooms.test.ts — session-scoped read rooms + the
// foreign-read gate (the cross-room pollution fix). A session's mesh
// identity (`.mesh/identity-<sessionId>.json`, cwd-relative) is the
// source of truth for what "its" rooms are; the machine config no longer
// decides the DEFAULT read of a session that has rooms of its own.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import boardExtension from "../src/extension/index.js";
import type { ExtensionAPI, SessionStartCtx, ToolDefinition } from "../src/extension/pi-types.js";
import { buildBoardRuntime, type BoardRuntime } from "../src/extension/runtime.js";
import { TypedBoard } from "../src/entries/board.js";
import { BoardStore } from "../src/store/store.js";

/** hermetic env: tmp state root, no inherited PI_BOARD_* / MESH_* */
const ENV_KEYS = ["PI_BOARD_STATE_DIR", "PI_BOARD_ROOM", "PI_BOARD_OBSERVER", "PI_BOARD_ALIAS", "MESH_RUNTIME_DIR", "MESH_NO_AUTO_BROKER"];

interface Guard {
  env: NodeJS.ProcessEnv;
  set(key: string, value: string | undefined): void;
  restore(): void;
}

function envGuard(): Guard {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ENV_KEYS) delete env[key];
  return {
    env,
    set: (key, value) => {
      if (value === undefined) delete env[key];
      else env[key] = value;
    },
    restore: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

interface Ctx {
  guard: Guard;
  root: string; // state root + cwd for the identity
  sessionId: string;
  /** write the session's mesh identity file with these rooms */
  identity(rooms: string[]): void;
  /** write the machine board.json role config */
  config(room: string, observer: boolean): void;
  runtime(): BoardRuntime;
  tools(rt: BoardRuntime): Map<string, ToolDefinition>;
  cleanup(): void;
}

function withCtx(fn: (ctx: Ctx) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const guard = envGuard();
    const root = mkdtempSync(path.join(tmpdir(), "pi-board-srooms-"));
    const sessionId = "01234567-89ab-4cde-8f01-234567890abc";
    guard.set("PI_BOARD_STATE_DIR", path.join(root, "state"));
    guard.set("MESH_RUNTIME_DIR", path.join(root, "no-broker")); // probe fails → no attach, no sockets
    const ctx: Ctx = {
      guard,
      root,
      sessionId,
      identity(rooms: string[]) {
        mkdirSync(path.join(root, ".mesh"), { recursive: true });
        writeFileSync(
          path.join(root, ".mesh", `identity-${sessionId}.json`),
          JSON.stringify({ version: 1, sessionId, alias: "agent-test", rooms }),
        );
      },
      config(room: string, observer: boolean) {
        mkdirSync(path.join(root, "state"), { recursive: true });
        writeFileSync(path.join(root, "state", "board.json"), JSON.stringify({ room, alias: "board-test", observer, watermarkMs: 0 }));
      },
      runtime: () => buildBoardRuntime(guard.env, { cwd: root, sessionId }),
      tools: (rt: BoardRuntime) => {
        const tools = new Map<string, ToolDefinition>();
        const handlers = new Map<string, (event: unknown, ctx?: SessionStartCtx) => void>();
        const pi = {
          registerTool: (def: ToolDefinition) => tools.set(def.name, def),
          on: (event: string, fn: (event: unknown, ctx?: SessionStartCtx) => void) => handlers.set(event, fn),
        } as unknown as ExtensionAPI;
        boardExtension(pi, { runtime: () => rt });
        handlers.get("session_start")?.({}, { sessionId, cwd: root });
        return tools;
      },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
    try {
      await fn(ctx);
    } finally {
      guard.restore();
      ctx.cleanup();
    }
  };
}

/** seed an entry into a room's store directly (no gate involved) */
function seed(ctx: Ctx, room: string, text: string): void {
  const store = new BoardStore(path.join(ctx.guard.env.PI_BOARD_STATE_DIR!, room));
  new TypedBoard(store).write({ type: "FACT", room, text, author: "seeder" });
}

async function run(tool: ToolDefinition | undefined, params: Record<string, unknown>): Promise<string> {
  assert.ok(tool !== undefined, "tool registered");
  const res = await tool!.execute("c", params, undefined, undefined, undefined);
  return res.content[0]?.text ?? "";
}

describe("session-scoped read rooms (the pollution fix)", () => {
  it("HOST CONTRACT (review blocker 1): the DEFAULT path resolves the session id via sessionManager.getSessionId() — the real host shape", withCtx(async (ctx) => {
    ctx.identity(["zoma"]);
    seed(ctx, "zoma", "resolved through the production wiring");
    // drive the extension's DEFAULT builder (no injected runtime) with a
    // REAL-host-shaped ctx: cwd + sessionManager — no sessionId field.
    // The default builder reads process.env: patch it for the test scope.
    const tools = new Map<string, ToolDefinition>();
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
    const pi = {
      registerTool: (def: ToolDefinition) => tools.set(def.name, def),
      on: (event: string, fn: (event: unknown, ctx?: unknown) => void) => handlers.set(event, fn),
    } as unknown as ExtensionAPI;
    const saved: Record<string, string | undefined> = {};
    for (const key of [...ENV_KEYS, "MESH_STATE_DIR"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PI_BOARD_STATE_DIR = ctx.guard.env.PI_BOARD_STATE_DIR;
    process.env.MESH_RUNTIME_DIR = ctx.guard.env.MESH_RUNTIME_DIR;
    try {
      boardExtension(pi); // ← default path
      handlers.get("session_start")?.({}, { cwd: ctx.root, sessionManager: { getSessionId: () => ctx.sessionId } });
      const read = await run(tools.get("board_read"), {});
      assert.match(read, /resolved through the production wiring/);
      assert.ok(!read.includes("foreign"));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }));

  it("ASYNC IDENTITY (review blocker 2): the identity file lands AFTER session_start (pi-mesh writes on ready) — the read still resolves it", withCtx(async (ctx) => {
    seed(ctx, "zoma", "explicit reads work before the identity lands");
    // fire session_start BEFORE the identity exists — a brand-new session
    const rt = ctx.runtime();
    const tools = ctx.tools(rt);
    const before = await run(tools.get("board_read"), { room: "zoma" });
    assert.match(before, /explicit reads work before the identity lands/); // explicit room works meanwhile
    ctx.identity(["zoma"]); // ← pi-mesh writes the file now (async "ready")
    seed(ctx, "zoma", "late identity, still picked up");
    const read = await run(tools.get("board_read"), {});
    assert.match(read, /late identity, still picked up/); // fresh resolution, no snapshot
  }));

  it("multi-room identity NEVER silently defaults to the machine config (review major)", withCtx(async (ctx) => {
    ctx.identity(["zoma", "rizob"]);
    ctx.config("muse", false); // the silent fallback the review killed
    seed(ctx, "muse", "must not be the default context");
    const tools = ctx.tools(ctx.runtime());
    const read = await run(tools.get("board_read"), {});
    assert.match(read, /pass room explicitly/);
    assert.ok(!read.includes("must not be the default"), "the config board leaked as the default");
  }));

  it("crossRoom:true on an OWN room reads normally — no banner", withCtx(async (ctx) => {
    ctx.identity(["zoma"]);
    seed(ctx, "zoma", "own room entry");
    const tools = ctx.tools(ctx.runtime());
    const read = await run(tools.get("board_read"), { crossRoom: true });
    assert.match(read, /own room entry/);
    assert.ok(!read.includes("foreign"));
  }));

  it("WRITE gate symmetry: a member config writes its own board; a foreign room is refused with no escape", withCtx(async (ctx) => {
    ctx.config("muse", false); // member of muse
    const tools = ctx.tools(ctx.runtime());
    const own = await run(tools.get("board_write"), { type: "FACT", text: "writing the machine board" });
    assert.match(own, /writing the machine board/);
    const foreign = await run(tools.get("board_write"), { room: "rizob", type: "FACT", text: "must be refused" });
    assert.match(foreign, /not_your_room/);
    assert.match(foreign, /write premise is membership/);
  }));

  it("MESH_STATE_DIR relocates the identity store (review major)", withCtx(async (ctx) => {
    mkdirSync(path.join(ctx.root, "alt-mesh"), { recursive: true });
    writeFileSync(
      path.join(ctx.root, "alt-mesh", `identity-${ctx.sessionId}.json`),
      JSON.stringify({ version: 1, sessionId: ctx.sessionId, rooms: ["zoma"] }),
    );
    ctx.guard.set("MESH_STATE_DIR", path.join(ctx.root, "alt-mesh"));
    seed(ctx, "zoma", "identity from the relocated store");
    const tools = ctx.tools(ctx.runtime());
    const read = await run(tools.get("board_read"), {});
    assert.match(read, /identity from the relocated store/);
  }));

  it("identity room OUTRANKS the machine config: agent in zoma on a muse-configured machine defaults to zoma", withCtx(async (ctx) => {
    ctx.identity(["zoma"]);
    ctx.config("muse", false); // the old pollution vector: machine board = muse
    seed(ctx, "muse", "muse entry that must NOT be the default context");
    seed(ctx, "zoma", "zoma entry the agent works on");
    const tools = ctx.tools(ctx.runtime());
    const read = await run(tools.get("board_read"), {});
    assert.match(read, /zoma entry the agent works on/);
    assert.ok(!read.includes("muse entry"), "the muse board leaked into the default read");
  }));

  it("foreign room: refused without crossRoom, banner-marked with it", withCtx(async (ctx) => {
    ctx.identity(["zoma"]);
    seed(ctx, "muse", "muse fact");
    const tools = ctx.tools(ctx.runtime());
    const refused = await run(tools.get("board_read"), { room: "muse" });
    assert.match(refused, /not_your_room/);
    assert.match(refused, /crossRoom: true/);
    const allowed = await run(tools.get("board_read"), { room: "muse", crossRoom: true });
    assert.match(allowed, /⚠ foreign board \[muse\]/);
    assert.match(allowed, /muse fact/);
    // grep and watch share the gate (grep needs the explicit foreign room —
    // without it, it searches the session's own default room)
    const grepRefused = await run(tools.get("board_grep"), { query: "muse", room: "muse" });
    assert.match(grepRefused, /not_your_room/);
    const watchRefused = await run(tools.get("board_watch"), { room: "muse" });
    assert.match(watchRefused, /not_your_room/);
  }));

  it("the machine's OWN config room is never foreign (coherent with the write gate)", withCtx(async (ctx) => {
    ctx.config("muse", false);
    seed(ctx, "muse", "machine board entry");
    const tools = ctx.tools(ctx.runtime());
    const read = await run(tools.get("board_read"), {}); // no identity → config default
    assert.match(read, /machine board entry/);
    const explicit = await run(tools.get("board_read"), { room: "muse" }); // and never flagged foreign
    assert.ok(!explicit.includes("foreign"));
  }));

  it("no identity, no env, no config: explicit room stays free (the v0.2 store-only feature), no banner", withCtx(async (ctx) => {
    seed(ctx, "anyroom", "store-only entry");
    const rt = ctx.runtime();
    assert.equal(rt.readRoom, undefined);
    const tools = ctx.tools(rt);
    const needRoom = await run(tools.get("board_read"), {});
    assert.match(needRoom, /pass room explicitly/);
    const explicit = await run(tools.get("board_read"), { room: "anyroom" });
    assert.match(explicit, /store-only entry/);
    assert.ok(!explicit.includes("foreign")); // nothing to judge foreignness against
  }));

  it("multi-room identity: no silent default — the error names the rooms", withCtx(async (ctx) => {
    ctx.identity(["zoma", "rizob"]);
    const tools = ctx.tools(ctx.runtime());
    const read = await run(tools.get("board_read"), {});
    assert.match(read, /rooms \[zoma, rizob\]/);
    assert.match(read, /pass room explicitly/);
    // an explicit pick among OWN rooms is not foreign
    const pick = await run(tools.get("board_read"), { room: "rizob" });
    assert.ok(!pick.includes("not_your_room"));
  }));

  it("env room counts as the session's own (operator pin)", withCtx(async (ctx) => {
    ctx.identity(["zoma"]);
    ctx.guard.set("PI_BOARD_ROOM", "default");
    seed(ctx, "default", "env-pinned entry");
    const tools = ctx.tools(ctx.runtime());
    const read = await run(tools.get("board_read"), {});
    assert.match(read, /env-pinned entry/); // env wins over identity
  }));

  it("corrupt identity degrades to no rooms (never a crash), config still applies", withCtx(async (ctx) => {
    mkdirSync(path.join(ctx.root, ".mesh"), { recursive: true });
    writeFileSync(path.join(ctx.root, ".mesh", `identity-${ctx.sessionId}.json`), "NOT JSON");
    ctx.config("muse", false);
    seed(ctx, "muse", "degraded but working");
    const rt = ctx.runtime();
    assert.deepEqual(rt.rooms, ["muse"]);
    const tools = ctx.tools(rt);
    const read = await run(tools.get("board_read"), {});
    assert.match(read, /degraded but working/);
  }));
});
