// test/cli.test.ts — the piboard surface as real subprocesses against a
// real broker: five subcommands, honest exit-code routing, observer writes
// refused through the CLI, the join daemon announcing, watch's FAIL line.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { TypedBoard } from "../src/entries/board.js";
import { boardDir } from "../src/store/store.js";

const CLI = path.resolve("dist/src/cli.js");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  root: string;
  runDir: string;
  stateDir: string;
  broker: { close(): Promise<void> };
  childEnv: NodeJS.ProcessEnv;
  spawnCli: (args: string[], opts?: { stdin?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;
  spawnBg: (args: string[]) => { child: ChildProcess; stdout: () => string; waitLine: (pattern: RegExp, timeoutMs?: number) => Promise<void>; stop: () => Promise<void> };
  cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-board-cli-"));
  const runDir = path.join(root, "run");
  const stateDir = path.join(root, "state");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const brokerMod = await import("pi-mesh-extension/dist/src/broker/broker.js");
  const { DEFAULT_CONFIG } = await import("pi-mesh-extension/dist/src/shared/config.js");
  const { DEFAULT_POLICY } = await import("pi-mesh-extension/dist/src/broker/policy.js");
  const broker = await brokerMod.createBroker({
    socketPath: path.join(runDir, "broker.sock"),
    config: DEFAULT_CONFIG,
    policy: DEFAULT_POLICY,
    stateDir,
  });
  // Hermetic: inherited PI_BOARD_* from a developer shell must never leak
  // into a test run (scrub first, then inject the test's own values).
  const SCRUB_ENV_KEYS = ["PI_BOARD_STATE_DIR", "PI_BOARD_ROOM", "PI_BOARD_ALIAS", "PI_BOARD_AUTHOR"];
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUB_ENV_KEYS) delete base[key];
  const childEnv = {
    ...base,
    MESH_RUNTIME_DIR: runDir,
    PI_BOARD_STATE_DIR: stateDir,
    PI_BOARD_ALIAS: "board-test",
  };
  const children: ChildProcess[] = [];
  const spawnCli = (args: string[], opts: { stdin?: string } = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      if (opts.stdin !== undefined) child.stdin!.write(opts.stdin);
      child.stdin!.end();
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  const spawnBg = (args: string[]) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    return {
      child,
      stdout: () => stdout,
      waitLine: async (pattern: RegExp, timeoutMs = 8_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (pattern.test(stdout)) return;
          await sleep(50);
        }
        throw new Error(`timeout waiting for ${pattern} in: ${stdout}`);
      },
      stop: () =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.on("close", () => resolve());
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }),
    };
  };
  return {
    root,
    runDir,
    stateDir,
    broker,
    childEnv,
    spawnCli,
    spawnBg,
    cleanup: async () => {
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await sleep(20);
        }
      }
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("cli: usage and honest exit codes", () => {
  it("no args and unknown commands are usage errors (exit 2)", async () => {
    const h = await harness();
    try {
      assert.equal((await h.spawnCli([])).code, 2);
      assert.equal((await h.spawnCli(["frobnicate"])).code, 2);
      const grep = await h.spawnCli(["grep"]);
      assert.equal(grep.code, 2);
      assert.match(grep.stderr, /grep needs a query/);
    } finally {
      await h.cleanup();
    }
  });

  it("commands without any room resolve to honest errors (exit 1)", async () => {
    const h = await harness();
    try {
      // write/watch still require a joined role (the gate's premise);
      // read/grep need SOME room source — with none, "no room", not a guess.
      for (const args of [["write", "--type", "FACT", "--text", "x"], ["watch"]]) {
        const res = await h.spawnCli(args);
        assert.equal(res.code, 1, `${args.join(" ")} before join`);
        assert.match(res.stderr, /not joined/);
      }
      for (const args of [["read"], ["grep", "x"]]) {
        const res = await h.spawnCli(args);
        assert.equal(res.code, 1, `${args.join(" ")} with no room source`);
        assert.match(res.stderr, /no room/);
      }
    } finally {
      await h.cleanup();
    }
  });
});

describe("cli: observer role refuses every write", () => {
  it("join --observer persists the role; a CLI write exits 4 with the reason", async () => {
    const h = await harness();
    try {
      const join = h.spawnBg(["join", "mesh", "--observer"]);
      await join.waitLine(/joined mesh as board-test \(observer\)/);
      await join.stop();
      const role = JSON.parse(readFileSync(path.join(h.stateDir, "board.json"), "utf8")) as { observer: boolean; room: string };
      assert.equal(role.observer, true);
      assert.equal(role.room, "mesh");

      const res = await h.spawnCli(["write", "--type", "FACT", "--text", "observers never write"]);
      assert.equal(res.code, 4);
      assert.match(res.stderr, /observer_readonly/);
      // The gate refused BEFORE the store: the board reads back empty (the
      // join daemon's poller creates the directory; emptiness is the proof).
      const list = await h.spawnCli(["read"]);
      assert.equal(list.code, 0);
      assert.equal(list.stdout, "");
    } finally {
      await h.cleanup();
    }
  });
});

describe("cli: member round-trip with the join daemon announcing", () => {
  it("join(member) → write → announce → read → grep → read --id", async () => {
    const h = await harness();
    try {
      const join = h.spawnBg(["join", "mesh"]);
      await join.waitLine(/joined mesh as board-test \(member\)/);

      const write = await h.spawnCli(["write", "--type", "FAIL", "--text", "port probe 13389 hangs", "--detail-file", "-"], {
        stdin: "connect timeout after 3s — firewall rule drops SYN on the host network",
      });
      assert.equal(write.code, 0);
      const id = write.stdout.split(" ")[0]!;
      assert.match(id, /^b1$/);
      await join.waitLine(new RegExp(`announced ${id} FAIL`));

      const list = await h.spawnCli(["read"]);
      assert.equal(list.code, 0);
      assert.match(list.stdout, /b1 FAIL .*port probe 13389 hangs/);

      const detail = await h.spawnCli(["read", "--id", id]);
      assert.equal(detail.code, 0);
      assert.match(detail.stdout, /connect timeout after 3s/);

      const missing = await h.spawnCli(["read", "--id", "b999"]);
      assert.equal(missing.code, 3);
      assert.match(missing.stderr, /no entry b999/);

      const hit = await h.spawnCli(["grep", "firewall"]);
      assert.equal(hit.code, 0);
      assert.match(hit.stdout, /b1 FAIL \(in detail\) port probe 13389 hangs/);

      const miss = await h.spawnCli(["grep", "nothing-matches"]);
      assert.equal(miss.code, 0);
      assert.equal(miss.stdout, "");

      const badType = await h.spawnCli(["write", "--type", "IDEA", "--text", "nope"]);
      assert.equal(badType.code, 2);
      assert.match(badType.stderr, /--type must be one of/);
      await join.stop();
    } finally {
      await h.cleanup();
    }
  });
});

describe("cli: pick round 1 (PR#1 comparison)", () => {
  it("a corrupt board.json is a clean usage error with the path — never 'not joined'", async () => {
    const h = await harness();
    try {
      writeFileSync(path.join(h.stateDir, "board.json"), "{ not json");
      const res = await h.spawnCli(["read"]);
      assert.equal(res.code, 2);
      assert.match(res.stderr, /board config unreadable/);
      assert.match(res.stderr, /fix or remove it/);
    } finally {
      await h.cleanup();
    }
  });

  it("a bare first run: join with no pre-created state dirs succeeds (issue #3)", async () => {
    const h = await harness();
    try {
      // Nothing under this path exists — not the root, not the room dir.
      const freshRoot = path.join(h.stateDir, "never", "created", "deeply");
      // join is a long-running presence: watch for the joined line, then stop it
      const child = spawn(process.execPath, [CLI, "join", "mesh"], {
        env: { ...h.childEnv, PI_BOARD_STATE_DIR: freshRoot },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && !/joined mesh as board-test \(member\)/.test(out)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.match(out, /joined mesh as board-test \(member\)/, "the bare first-run join succeeded");
      const stopped = new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
      child.kill("SIGTERM");
      // Under load the graceful stop can be slow; escalate hard and ALWAYS
      // wait for the exit — a lingering presence would hang the harness
      // broker's close (learned the hard way in this very suite).
      const code = await Promise.race([
        stopped,
        new Promise<number>((r) =>
          setTimeout(() => {
            child.kill("SIGKILL");
            setTimeout(() => r(-9), 500);
          }, 3_000),
        ),
      ]);
      assert.equal(code, 0, `clean stop after first-run join (got ${code})`);
      assert.equal(existsSync(path.join(freshRoot, "board.json")), true, "the config landed in the fresh root");
      assert.equal(existsSync(path.join(freshRoot, "mesh", "segments")), true, "the room store landed too");
    } finally {
      await h.cleanup();
    }
  });

  it("read/grep accept a store-only --room; write keeps its join requirement", async () => {
    const h = await harness();
    try {
      // No join at all: --room makes reads script-friendly.
      const board = new TypedBoard(new (await import("../src/store/store.js")).BoardStore(boardDir("mesh", h.childEnv)));
      board.write({ type: "FACT", author: "seed", room: "mesh", text: "seeded without any join" });
      const list = await h.spawnCli(["read", "--room", "mesh"]);
      assert.equal(list.code, 0);
      assert.match(list.stdout, /seeded without any join/);
      const hit = await h.spawnCli(["grep", "seeded", "--room", "mesh"]);
      assert.equal(hit.code, 0);
      assert.match(hit.stdout, /FACT seeded without any join/);
      // No room anywhere and no join: honest error.
      const noRoom = await h.spawnCli(["read"]);
      assert.equal(noRoom.code, 1);
      assert.match(noRoom.stderr, /no room/);
      // write has no --room option at all: the role gate's premise stands.
      const gated = await h.spawnCli(["write", "--type", "FACT", "--text", "x", "--room", "mesh"]);
      assert.equal(gated.code, 2);
      assert.match(gated.stderr, /unknown option/);
    } finally {
      await h.cleanup();
    }
  });

  it("SPECS parser surface: help topics, unknown options, inline values, --, positional rejection", async () => {
    const h = await harness();
    try {
      assert.equal((await h.spawnCli(["help"])).code, 0);
      const helpWrite = await h.spawnCli(["help", "write"]);
      assert.equal(helpWrite.code, 0);
      assert.match(helpWrite.stdout, /--detail-file/);
      assert.match(helpWrite.stdout, /--lease-ref/);
      assert.equal((await h.spawnCli(["help", "bogus"])).code, 2);
      const unknown = await h.spawnCli(["write", "--frobnicate", "x"]);
      assert.equal(unknown.code, 2);
      assert.match(unknown.stderr, /unknown option/);

      const join = h.spawnBg(["join", "mesh"]);
      await join.waitLine(/joined mesh as board-test \(member\)/);
      // inline --opt=value form
      await h.spawnCli(["write", "--type=FACT", "--text=inline form works"]);
      const list = await h.spawnCli(["read", "--limit=5"]);
      assert.match(list.stdout, /FACT .*inline form works/);
      // `--` end-of-options: a query starting with dashes is still a query
      const dashy = await h.spawnCli(["grep", "--", "--type=FACT"]);
      assert.equal(dashy.code, 0, "no unknown-option error: after -- everything is a query");
      assert.equal(dashy.stdout, "", "and the literal query honestly misses");
      const plain = await h.spawnCli(["grep", "inline"]);
      assert.match(plain.stdout, /inline form works/);
      // write takes no positionals (usage, not a hidden ignore)
      const pos = await h.spawnCli(["write", "stray", "--type", "FACT", "--text", "x"]);
      assert.equal(pos.code, 2);
      assert.match(pos.stderr, /no positional/);
      await join.stop();
    } finally {
      await h.cleanup();
    }
  });

  it("grep --type/--limit flags: filter, cap, and honest usage errors", async () => {
    const h = await harness();
    try {
      const join = h.spawnBg(["join", "mesh"]);
      await join.waitLine(/joined mesh as board-test \(member\)/);
      await h.spawnCli(["write", "--type", "FAIL", "--text", "probe timeout"]);
      await h.spawnCli(["write", "--type", "FACT", "--text", "timeout is by design"]);
      const filtered = await h.spawnCli(["grep", "timeout", "--type", "FAIL"]);
      assert.equal(filtered.code, 0);
      assert.match(filtered.stdout, /b1 FAIL/);
      assert.equal(filtered.stdout.includes("FACT"), false);
      const capped = await h.spawnCli(["grep", "timeout", "--limit", "1"]);
      assert.equal(capped.stdout.trim().split("\n").length, 1);
      const badType = await h.spawnCli(["grep", "timeout", "--type", "IDEA"]);
      assert.equal(badType.code, 2);
      const badLimit = await h.spawnCli(["grep", "timeout", "--limit", "0"]);
      assert.equal(badLimit.code, 2);
      await join.stop();
    } finally {
      await h.cleanup();
    }
  });

  it("an interactive terminal is refused for --detail-file - instead of hanging", async () => {
    const { stdinDetailGuard } = await import("../src/cli/main.js");
    assert.match(stdinDetailGuard(true) ?? "", /refuses an interactive terminal/);
    assert.equal(stdinDetailGuard(false), undefined);
  });
});

describe("cli: review-round hardening", () => {
  it("usage validation precedes role/gate even on an observer board", async () => {
    const h = await harness();
    try {
      const join = h.spawnBg(["join", "mesh", "--observer"]);
      await join.waitLine(/joined mesh as board-test \(observer\)/);
      await join.stop();
      const noFlags = await h.spawnCli(["write"]);
      assert.equal(noFlags.code, 2, "a malformed invocation is a usage error, not a refusal");
      const noText = await h.spawnCli(["write", "--type", "FACT"]);
      assert.equal(noText.code, 2);
      const badType = await h.spawnCli(["write", "--type", "IDEA", "--text", "x"]);
      assert.equal(badType.code, 2);
      assert.match(badType.stderr, /--type must be one of/);
      // A WELL-FORMED write on the observer board still refuses (exit 4).
      const refused = await h.spawnCli(["write", "--type", "FACT", "--text", "nope"]);
      assert.equal(refused.code, 4);
    } finally {
      await h.cleanup();
    }
  });

  it("--detail-file is a bounded read: past the byte bound it refuses at ingestion", async () => {
    const h = await harness();
    try {
      const join = h.spawnBg(["join", "mesh"]);
      await join.waitLine(/joined mesh as board-test \(member\)/);
      const big = await h.spawnCli(["write", "--type", "FACT", "--text", "x", "--detail-file", "-"], {
        stdin: "z".repeat(8_193),
      });
      assert.equal(big.code, 1);
      assert.match(big.stderr, /exceeds the 8192-byte bound/);
      const list = await h.spawnCli(["read"]);
      assert.equal(list.stdout, "", "the refused write left no trace");
      const ok = await h.spawnCli(["write", "--type", "FACT", "--text", "fine", "--detail-file", "-"], {
        stdin: "z".repeat(100),
      });
      assert.equal(ok.code, 0);
      await join.stop();
    } finally {
      await h.cleanup();
    }
  });

  it("--lease-ref lands on the entry (CLAIM ↔ mesh_claim correlation)", async () => {
    const h = await harness();
    try {
      const join = h.spawnBg(["join", "mesh"]);
      await join.waitLine(/joined mesh as board-test \(member\)/);
      const res = await h.spawnCli([
        "write", "--type", "CLAIM", "--text", "owning the deploy lane", "--lease-ref", "task7#lz3#12:1",
      ]);
      assert.equal(res.code, 0);
      const board = new TypedBoard(new (await import("../src/store/store.js")).BoardStore(boardDir("mesh", h.childEnv)));
      const entry = board.readById("b1");
      assert.equal(entry?.leaseRef, "task7#lz3#12:1");
      await join.stop();
    } finally {
      await h.cleanup();
    }
  });
});

describe("cli: watch prints the turn-boundary FAIL summary line", () => {
  it("a FAIL landing after watch starts produces the one-line summary", async () => {
    const h = await harness();
    try {
      // Join member first (watch reads the joined room), seed one OLD fail
      // that must NOT be reported (before watch's first boundary).
      const join = h.spawnBg(["join", "mesh"]);
      await join.waitLine(/joined mesh as board-test \(member\)/);
      const board = new TypedBoard(new (await import("../src/store/store.js")).BoardStore(boardDir("mesh", h.childEnv)));
      board.write({ type: "FAIL", author: "seed", room: "mesh", text: "old failure before the boundary" });

      const watch = h.spawnBg(["watch"]);
      await watch.waitLine(/watching mesh for new FAIL entries/);
      await h.spawnCli(["write", "--type", "FAIL", "--text", "watch sees this one"]);
      await watch.waitLine(/⚠ board\[.+\]: 1 new FAIL — b2:watch sees this one/);
      await watch.stop();
      await join.stop();
    } finally {
      await h.cleanup();
    }
  });
});
