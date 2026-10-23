// test/cli.test.ts — the piboard surface as real subprocesses against a
// real broker: five subcommands, honest exit-code routing, observer writes
// refused through the CLI, the join daemon announcing, watch's FAIL line.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const childEnv = {
    ...process.env,
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

  it("write/read/grep before join fail with the honest not-joined error (exit 1)", async () => {
    const h = await harness();
    try {
      for (const args of [["write", "--type", "FACT", "--text", "x"], ["read"], ["grep", "x"], ["watch"]]) {
        const res = await h.spawnCli(args);
        assert.equal(res.code, 1, `${args.join(" ")} before join`);
        assert.match(res.stderr, /not joined/);
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
      await watch.waitLine(/⚠ board: 1 new FAIL — b2:watch sees this one/);
      await watch.stop();
      await join.stop();
    } finally {
      await h.cleanup();
    }
  });
});
