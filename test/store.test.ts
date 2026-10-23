// test/store.test.ts — the append-only kernel: rotation immutability, caps
// that refuse (never evict), TTL visibility, fail-closed forbidden keys,
// and the env-override discipline. Real files in mkdtemp dirs, no mocks.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
