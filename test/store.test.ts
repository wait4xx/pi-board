// test/store.test.ts — the append-only kernel: rotation immutability, caps
// that refuse (never evict), TTL visibility, fail-closed forbidden keys,
// and the env-override discipline. Real files in mkdtemp dirs, no mocks.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { BoardFullError, BoardStore, ForbiddenKeyError } from "../src/store/store.js";
import { loadLimits } from "../src/shared/limits.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function store(dir: string, env: Record<string, string> = {}, now?: () => number): BoardStore {
  return new BoardStore(dir, { limits: loadLimits(env), ...(now !== undefined ? { now } : {}) });
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    // best effort
  }
}

describe("store: append / read / byId", () => {
  it("assigns monotonic b<seq36> ids and reads newest-first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-basic-"));
    try {
      const s = store(dir);
      const a = s.append({ text: "first" });
      const b = s.append({ text: "second" });
      assert.equal(a.id, "b1");
      assert.equal(b.id, "b2");
      assert.equal(s.read().map((e) => e.id).join(","), "b2,b1");
      assert.equal(s.byId("b1")?.text, "first");
      assert.equal(s.byId("missing"), undefined);
    } finally {
      cleanup(dir);
    }
  });

  it("ids survive reopen without reuse (reservation gap-safety)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-reopen-"));
    try {
      const first = store(dir);
      first.append({ text: "one" });
      first.append({ text: "two" });
      const second = store(dir); // fresh instance, same dir
      const c = second.append({ text: "three" });
      assert.equal(c.id, "b3", "a reopened store must never re-assign b2");
    } finally {
      cleanup(dir);
    }
  });
});

describe("store: rotation keeps old segments immutable and greppable", () => {
  it("rotates on the segment entry bound; the old segment never changes again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-rotate-"));
    try {
      const s = store(dir, { PI_BOARD_SEGMENT_MAX_ENTRIES: "2" });
      s.append({ text: "oldschool needle alpha" });
      s.append({ text: "oldschool needle beta" });
      s.append({ text: "fresh gamma" }); // triggers rotation to seg-000002
      const names = readdirSync(join(dir, "segments")).sort();
      assert.deepEqual(names, ["seg-000001.jsonl", "seg-000002.jsonl"]);

      const frozen = readFileSync(join(dir, "segments", "seg-000001.jsonl"), "utf8");
      s.append({ text: "more" });
      s.append({ text: "even more" }); // seg-000002 fills, seg-000003 opens
      assert.equal(
        readFileSync(join(dir, "segments", "seg-000001.jsonl"), "utf8"),
        frozen,
        "a rotated segment is immutable — appends only ever touch the newest one",
      );

      const hit = s.grepSubstr("needle");
      assert.equal(hit.length, 2, "rotated-away entries stay greppable");
      assert.equal(hit.every((h) => String(h.entry.text).includes("needle")), true);
    } finally {
      cleanup(dir);
    }
  });
});

describe("store: caps refuse, never evict", () => {
  it("the entry cap refuses the append past the bound with an honest error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-cap-n-"));
    try {
      const s = store(dir, { PI_BOARD_MAX_ENTRIES: "3" });
      s.append({ text: "1" });
      s.append({ text: "2" });
      s.append({ text: "3" });
      assert.throws(() => s.append({ text: "4" }), (err: unknown) => {
        assert.ok(err instanceof BoardFullError);
        assert.equal(err.bound, "maxEntries");
        assert.match(err.message, /board_full/);
        return true;
      });
      assert.equal(s.read().length, 3, "the refused append left no trace");
      assert.equal(s.physicalStats().entries, 3);
    } finally {
      cleanup(dir);
    }
  });

  it("the byte cap refuses when the next line would cross it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-cap-b-"));
    try {
      // Each line is ~75 bytes; a 100-byte cap fits one line, refuses two.
      const s = store(dir, { PI_BOARD_MAX_TOTAL_BYTES: "100" });
      s.append({ text: "one line of content" });
      assert.throws(
        () => s.append({ text: "another line of content" }),
        (err: unknown) => err instanceof BoardFullError && err.bound === "maxTotalBytes",
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe("store: TTL is a visibility bound", () => {
  it("expired entries disappear from read/byId/grep but stay on disk until pruned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-ttl-"));
    try {
      let clock = 1_000_000;
      const s = store(dir, { PI_BOARD_ENTRY_TTL_MS: "50" }, () => clock);
      s.append({ text: "fleeting remark" });
      assert.equal(s.read().length, 1);
      clock += 80; // past the TTL
      assert.equal(s.read().length, 0);
      assert.equal(s.byId("b1"), undefined);
      assert.equal(s.grepSubstr("fleeting").length, 0);
      assert.equal(existsSync(join(dir, "segments", "seg-000001.jsonl")), true, "pruning happens on rotation, not at expiry");
    } finally {
      cleanup(dir);
    }
  });
});

describe("store: forbidden keys are fail-closed", () => {
  it("secret shapes refuse the append and the error never echoes the secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-forbidden-"));
    try {
      const s = store(dir);
      const secrets = [
        { field: "text", value: "key is AKIAIOSFODNN7EXAMPLE ok" },
        { field: "detail", value: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 leaked" },
        { field: "text", value: "-----BEGIN RSA PRIVATE KEY-----" },
        { field: "text", value: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" },
      ];
      for (const { field, value } of secrets) {
        assert.throws(
          () => s.append({ [field]: value }),
          (err: unknown) => {
            assert.ok(err instanceof ForbiddenKeyError);
            const msg = err.message;
            assert.match(msg, /forbidden_key/);
            const secret = value.replace(/^(key is |token )/, "");
            assert.equal(msg.includes(secret.slice(0, 12)), false, "the error must not echo the secret");
            return true;
          },
        );
      }
      assert.equal(s.read().length, 0, "refused appends leave no trace");
    } finally {
      cleanup(dir);
    }
  });
});

describe("store: env overrides parse fail-closed", () => {
  it("a non-numeric or non-positive override is a startup error naming the variable", async () => {
    assert.throws(() => loadLimits({ PI_BOARD_MAX_ENTRIES: "abc" }), /PI_BOARD_MAX_ENTRIES/);
    assert.throws(() => loadLimits({ PI_BOARD_ENTRY_TTL_MS: "0" }), /PI_BOARD_ENTRY_TTL_MS/);
    assert.throws(() => loadLimits({ PI_BOARD_ENTRY_TTL_MS: "-5" }), /PI_BOARD_ENTRY_TTL_MS/);
  });

  it("a window default above the window max is a cross-field error", async () => {
    assert.throws(
      () => loadLimits({ PI_BOARD_READ_WINDOW_DEFAULT: "5000", PI_BOARD_READ_WINDOW_MAX: "1000" }),
      /READ_WINDOW_DEFAULT.*READ_WINDOW_MAX/,
    );
  });

  it("valid overrides take effect (the operator widens the TTL for a long task line)", async () => {
    const limits = loadLimits({ PI_BOARD_ENTRY_TTL_MS: "600000" });
    assert.equal(limits.entryTtlMs, 600_000);
  });
});

describe("store: field caps are enforced before any write", () => {
  it("text past 280 chars and detail past the bound refuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-toolong-"));
    try {
      const s = store(dir);
      assert.throws(() => s.append({ text: "x".repeat(281) }), /entry_too_long.*text/);
      assert.throws(() => s.append({ text: "ok", detail: "y".repeat(8_193) }), /entry_too_long.*detail/);
      assert.equal(s.read().length, 0);
    } finally {
      cleanup(dir);
    }
  });

  it("caps are BYTE bounds: 279 CJK chars are 837 bytes and refuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-bytes-"));
    try {
      const s = store(dir);
      assert.equal("汉".repeat(279).length, 279, "chars");
      assert.throws(() => s.append({ text: "汉".repeat(279) }), /entry_too_long.*text/);
      assert.equal(s.read().length, 0);
    } finally {
      cleanup(dir);
    }
  });

  it("unscannable deep nesting is refused, not silently passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-depth-"));
    try {
      const s = store(dir);
      let deep: Record<string, unknown> = { text: "bottom" };
      for (let i = 0; i < 12; i += 1) deep = { nested: deep };
      assert.throws(() => s.append(deep), /nesting deeper than 8/);
      assert.equal(s.read().length, 0);
    } finally {
      cleanup(dir);
    }
  });
});

describe("store: review-round hardening", () => {
  it("a torn tail line in an old segment never breaks the write path (prune skips it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-torn-"));
    try {
      let clock = 1_000_000;
      const s = store(dir, { PI_BOARD_SEGMENT_MAX_ENTRIES: "1", PI_BOARD_ENTRY_TTL_MS: "50" }, () => clock);
      s.append({ text: "first" }); // seg-000001
      s.append({ text: "second" }); // rotate → seg-000002
      // Simulate a crash mid-append on a THIRD segment: torn partial line.
      writeFileSync(join(dir, "segments", "seg-000003.jsonl"), '{"id":"bX","at":"2026-01', { flag: "a" });
      clock += 100; // seg1/seg2 fully expire
      const third = s.append({ text: "third" }); // rotate → prune walks all old segments
      assert.equal(third.id.startsWith("b"), true, "the write path survives the torn segment");
      const names = readdirSync(join(dir, "segments")).sort();
      // Prune removed the fully-expired segments but SKIPPED the torn one
      // (unparseable tail ≠ proven expired — it stays, invisible to queries).
      assert.equal(names.includes("seg-000001.jsonl"), false, "expired segment pruned");
      assert.equal(names.includes("seg-000002.jsonl"), false, "expired segment pruned");
      assert.equal(names.includes("seg-000003.jsonl"), true, "torn segment skipped by prune, not crashed on");
      assert.equal(s.read().some((entry) => entry.id === third.id), true);
    } finally {
      cleanup(dir);
    }
  });

  it("concurrent processes serialize on the append lock: ids stay unique", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-lock-"));
    const url = pathToFileURL(join(process.cwd(), "dist/src/store/store.js")).href;
    const childCode = `
      import { BoardStore } from ${JSON.stringify(url)};
      import { loadLimits } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/src/shared/limits.js")).href)};
      const store = new BoardStore(process.argv[2], { limits: loadLimits({}) });
      for (let i = 0; i < 15; i += 1) store.append({ text: "from-" + process.pid });
    `;
    try {
      const children = [0, 1, 2].map(() =>
        spawn(process.execPath, ["--input-type=module", "-e", childCode, "arg0", dir], { stdio: "ignore" }),
      );
      const codes = await Promise.all(children.map((child) => new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? -1)))));
      assert.deepEqual(codes, [0, 0, 0], "all three writers must succeed");
      const s = store(dir);
      const ids = s.read().map((entry) => entry.id);
      assert.equal(ids.length, 45);
      assert.equal(new Set(ids).size, 45, "no duplicate ids across processes");
    } finally {
      cleanup(dir);
    }
  });

  it("byte caps measure the FINAL line, not the id-less draft", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-finaline-"));
    try {
      // Draft line for this entry is ~70 bytes; the final line adds id+at
      // (~50 more). A cap that only fits the draft must refuse the append.
      const s = store(dir, { PI_BOARD_MAX_TOTAL_BYTES: "110", PI_BOARD_SEGMENT_MAX_BYTES: "110" });
      assert.throws(() => s.append({ text: "0123456789".repeat(6) }), /board_full|entry_too_large/);
      assert.equal(s.physicalStats().entries, 0);
    } finally {
      cleanup(dir);
    }
  });
});
