// test/cli.test.ts — task_0008: the piboard command surface, exit-code
// contract, room-resolution chain, detail via stdin, observer refusal,
// forbidden keys. Runs the BUILT CLI as a real subprocess in a hermetic
// PI_BOARD_STATE_DIR (mirror of the pi-mesh cli-send.test.ts setup).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "piboard.js");

/** Inherited PI_BOARD_* env must never leak into a test run (hermetic). */
const SCRUB_ENV_KEYS = ["PI_BOARD_STATE_DIR", "PI_BOARD_ROOM", "PI_BOARD_ALIAS", "PI_BOARD_AUTHOR"];

function hermeticEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUB_ENV_KEYS) delete base[key];
  return { ...base, ...extra };
}

interface Ctx {
  stateDir: string;
  run(
    args: string[],
    opts?: { stdin?: string },
  ): Promise<{ code: number; out: string; err: string }>;
  writeConfig(config: { room: string; observer: boolean; alias: string }): void;
}

function withRunCtx(fn: (ctx: Ctx) => Promise<void>): () => Promise<void> {
  return async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "pi-board-cli-"));
    const ctx: Ctx = {
      stateDir,
      run: (args, opts = {}) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [CLI, ...args], {
            env: hermeticEnv({ PI_BOARD_STATE_DIR: stateDir, PI_BOARD_AUTHOR: "cli-tester" }),
            stdio: ["pipe", "pipe", "pipe"],
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (c: Buffer) => {
            out += c.toString("utf8");
          });
          child.stderr.on("data", (c: Buffer) => {
            err += c.toString("utf8");
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
          if (opts.stdin !== undefined) {
            child.stdin.write(opts.stdin);
            child.stdin.end();
          } else {
            child.stdin.end();
          }
        }),
      writeConfig: (config) => {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(path.join(stateDir, "board.json"), JSON.stringify(config), "utf8");
      },
    };
    try {
      await fn(ctx);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  };
}

describe("task_0008: piboard CLI — store-only flow (no mesh)", () => {
  it("write → read → grep happy path via --room, exit 0", withRunCtx(async ({ run }) => {
    const w = await run(["write", "--room", "r1", "--type", "FACT", "--text", "le port de test est 4311"]);
    assert.equal(w.code, 0, w.err);
    assert.match(w.out.trimEnd(), /^b\d+ FACT cli-tester: le port de test est 4311$/);
    await run(["write", "--room", "r1", "--type", "FAIL", "--text", "monkey-patch fs: EBUSY"]);
    const r = await run(["read", "--room", "r1"]);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("EBUSY"));
    assert.ok(r.out.includes("4311"));
    const g = await run(["grep", "--room", "r1", "ebusy"]);
    assert.equal(g.code, 0);
    assert.match(g.out, /FAIL cli-tester: monkey-patch fs: EBUSY/);
  }));

  it("grep miss = exit 0, empty output, never an error", withRunCtx(async ({ run }) => {
    await run(["write", "--room", "r1", "--type", "FACT", "--text", "x"]);
    const g = await run(["grep", "--room", "r1", "nope-nope"]);
    assert.equal(g.code, 0);
    assert.equal(g.out, "");
  }));

  it("read --id unfolds detail and ref; unknown id = exit 3", withRunCtx(async ({ run }) => {
    const w = await run(
      ["write", "--room", "r1", "--type", "FAIL", "--text", "short", "--detail-file", "-", "--ref", "src/x.ts"],
      { stdin: "the long story of the failure\n" },
    );
    assert.equal(w.code, 0, w.err);
    const id = w.out.split(" ")[0]!;
    const r = await run(["read", "--room", "r1", "--id", id]);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("--- detail ---"));
    assert.ok(r.out.includes("the long story of the failure"));
    assert.ok(r.out.includes("ref: src/x.ts"));
    const miss = await run(["read", "--room", "r1", "--id", "b999"]);
    assert.equal(miss.code, 3);
  }));

  it("usage errors exit 2; unknown command/option exit 2", withRunCtx(async ({ run }) => {
    assert.equal((await run(["bogus"])).code, 2);
    assert.equal((await run(["write", "--text", "no type"])).code, 2);
    assert.equal((await run(["write", "--type", "NOPE", "--text", "x", "--room", "r"])).code, 2);
    assert.equal((await run(["grep"])).code, 2);
    assert.equal((await run(["read", "--room", "r", "--wat"])).code, 2);
  }));

  it("no room anywhere = honest usage error (exit 2), not a guess", withRunCtx(async ({ run }) => {
    const r = await run(["read"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("--room"));
  }));

  it("room resolution: --room flag wins over the joined config", withRunCtx(async ({ run, writeConfig }) => {
    writeConfig({ room: "cfg-room", observer: false, alias: "board" });
    const w = await run(["write", "--type", "FACT", "--text", "flag wins"]);
    assert.equal(w.code, 0, w.err); // env unset → config path
    assert.match(w.out, /FACT cli-tester: flag wins/);
    // a store-only write to ANOTHER room must not land in cfg-room
    const other = await run(["write", "--room", "other", "--type", "FACT", "--text", "elsewhere"]);
    assert.equal(other.code, 0, other.err);
    const cfg = await run(["grep", "elsewhere"]);
    assert.equal(cfg.code, 0);
    assert.equal(cfg.out, "");
  }));

  it("observer config refuses writes with exit 4 (gate, before the store)", withRunCtx(async ({ run, writeConfig }) => {
    writeConfig({ room: "obs-room", observer: true, alias: "board" });
    const w = await run(["write", "--type", "FACT", "--text", "must be refused"]);
    assert.equal(w.code, 4);
    assert.match(w.err, /observer_readonly/);
    // nothing persisted
    const r = await run(["read"]);
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
  }));

  it("forbidden key refuses the append (exit 1), nothing persisted", withRunCtx(async ({ run }) => {
    const w = await run(["write", "--room", "r1", "--type", "FACT", "--text", "key ghp_ABCDEFGHIJKLMNOPQRST here"]);
    assert.equal(w.code, 1);
    assert.match(w.err, /forbidden_key/);
    const r = await run(["read", "--room", "r1"]);
    assert.equal(r.out, "");
  }));

  it("watch prints the new-FAIL summary line once, then honest silence", withRunCtx(async ({ run }) => {
    await run(["write", "--room", "r1", "--type", "FAIL", "--text", "dead end A"]);
    await run(["write", "--room", "r1", "--type", "FACT", "--text", "not a fail"]);
    const first = await run(["watch", "--room", "r1"]);
    assert.equal(first.code, 0);
    assert.match(first.out, /1 new FAIL/);
    assert.ok(first.out.includes("dead end A"));
    const second = await run(["watch", "--room", "r1"]);
    assert.equal(second.code, 0);
    assert.equal(second.out, ""); // cursor advanced — honest silence
  }));

  it("help exits 0 (general and per command)", withRunCtx(async ({ run }) => {
    assert.equal((await run(["--help"])).code, 0);
    assert.equal((await run(["help"])).code, 0);
    assert.equal((await run(["help", "write"])).code, 0);
    assert.equal((await run(["help", "nope"])).code, 2);
  }));
});
