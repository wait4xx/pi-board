// test/entries.test.ts — typed entries: the closed five-type set, detail
// unfold, the read window, and the boolean grep truth table (with the
// id-always + `(in detail)` marker contract from the design gate).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BoardStore } from "../src/store/store.js";
import { TypedBoard } from "../src/entries/board.js";
import { loadLimits } from "../src/shared/limits.js";
import { ENTRY_TYPES } from "../src/entries/types.js";

function board(dir: string, env: Record<string, string> = {}): TypedBoard {
  return new TypedBoard(new BoardStore(dir, { limits: loadLimits(env) }));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    // best effort
  }
}

describe("entries: the five types form a closed set", () => {
  it("each type round-trips; an unknown type is rejected at write time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-types-"));
    try {
      const b = board(dir);
      for (const type of ENTRY_TYPES) {
        const entry = b.write({ type, author: "alice", room: "mesh", text: `${type} line` });
        assert.equal(entry.type, type);
      }
      assert.throws(
        () => b.write({ type: "THOUGHT" as never, author: "alice", room: "mesh", text: "nope" }),
        /entry_invalid.*type/,
      );
      assert.equal(b.read().length, 5, "the refused write left no trace");
    } finally {
      cleanup(dir);
    }
  });

  it("missing author/room/text refuse; CLAIM's leaseRef is a plain annotation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-fields-"));
    try {
      const b = board(dir);
      assert.throws(() => b.write({ type: "FACT", author: "", room: "mesh", text: "x" }), /author/);
      assert.throws(() => b.write({ type: "FACT", author: "a", room: "", text: "x" }), /room/);
      assert.throws(() => b.write({ type: "FACT", author: "a", room: "mesh", text: "" }), /text/);
      const claim = b.write({ type: "CLAIM", author: "a", room: "mesh", text: "owning the deploy", leaseRef: "task7#lz3#12:1" });
      assert.equal(claim.leaseRef, "task7#lz3#12:1");
      assert.equal(b.readById(claim.id)?.leaseRef, "task7#lz3#12:1");
    } finally {
      cleanup(dir);
    }
  });
});

describe("entries: detail is stored once, unfolded on demand", () => {
  it("summaries stay short; readById returns the full record with detail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-detail-"));
    try {
      const b = board(dir);
      const entry = b.write({
        type: "FAIL",
        author: "bob",
        room: "mesh",
        text: "pg dump fails on TLS handshake",
        detail: "psql: error: SSL error: certificate verify failed at libpq auth.c:412 — CA bundle path mismatch",
      });
      assert.equal(b.read().length, 1);
      assert.equal(b.read()[0]!.id, entry.id);
      const unfolded = b.readById(entry.id);
      assert.match(unfolded!.detail ?? "", /certificate verify failed/);
    } finally {
      cleanup(dir);
    }
  });
});

describe("entries: the read window", () => {
  it("returns newest-first and truncates to the requested limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-window-"));
    try {
      const b = board(dir);
      for (let i = 1; i <= 5; i += 1) b.write({ type: "OBSERVED", author: "a", room: "mesh", text: `row ${i}` });
      assert.deepEqual(
        b.read(3).map((e) => e.text),
        ["row 5", "row 4", "row 3"],
      );
      assert.deepEqual(
        b.read().map((e) => e.text),
        ["row 5", "row 4", "row 3", "row 2", "row 1"],
      );
    } finally {
      cleanup(dir);
    }
  });

  it("a limit above the configured max is clamped, not an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-clamp-"));
    try {
      const b = board(dir, { PI_BOARD_READ_WINDOW_MAX: "3", PI_BOARD_READ_WINDOW_DEFAULT: "2" });
      for (let i = 1; i <= 5; i += 1) b.write({ type: "OBSERVED", author: "a", room: "mesh", text: `row ${i}` });
      assert.equal(b.read(9_999).length, 3);
    } finally {
      cleanup(dir);
    }
  });
});

describe("entries: boolean grep truth table", () => {
  it("`,` = OR, `&` = AND, AND binds tighter, all case-insensitive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-grep-"));
    try {
      const b = board(dir);
      b.write({ type: "FACT", author: "a", room: "mesh", text: "Node 22 LTS is the baseline" });
      b.write({ type: "FAIL", author: "b", room: "mesh", text: "qemu build breaks on arm64", detail: "toolchain glibc 2.41 mismatch" });
      b.write({ type: "OBSERVED", author: "c", room: "mesh", text: "broker restart reclaims aliases" });

      // single term, case-insensitive
      assert.deepEqual(b.grep("node 22").map((r) => r.entry.id), ["b1"]);
      // OR
      assert.equal(b.grep("qemu,broker").length, 2);
      // AND within one entry
      assert.deepEqual(b.grep("qemu&arm64").map((r) => r.entry.id), ["b2"]);
      // AND that no entry satisfies
      assert.deepEqual(b.grep("qemu&broker"), []);
      // precedence: a OR (b AND c) — newest-first: b3 (broker) then b2 (the AND group)
      assert.deepEqual(b.grep("broker,qemu&arm64").map((r) => r.entry.id), ["b3", "b2"]);
      // a term living only in detail
      assert.deepEqual(b.grep("glibc").map((r) => r.entry.id), ["b2"]);
    } finally {
      cleanup(dir);
    }
  });

  it("every row carries the id; a detail-only match is marked (in detail)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-marker-"));
    try {
      const b = board(dir);
      b.write({ type: "FAIL", author: "a", room: "mesh", text: "cert verify failed", detail: "openssl errno 20 at depth 0" });
      b.write({ type: "FACT", author: "b", room: "mesh", text: "openssl 3.5 in the image" });

      const textHit = b.grep("openssl");
      assert.equal(textHit.length, 2);
      const flagged = textHit.filter((r) => r.matchedInDetail);
      assert.deepEqual(
        flagged.map((r) => r.entry.id),
        ["b1"],
        "b1's text alone does not contain 'openssl' — only its detail does",
      );
      assert.equal(textHit.every((r) => typeof r.entry.id === "string"), true);
    } finally {
      cleanup(dir);
    }
  });

  it("grep reaches beyond the read window into rotated-alive segments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-span-"));
    try {
      const b = board(dir, { PI_BOARD_READ_WINDOW_MAX: "2", PI_BOARD_READ_WINDOW_DEFAULT: "2" });
      for (let i = 1; i <= 5; i += 1) b.write({ type: "FACT", author: "a", room: "mesh", text: `row ${i}` });
      assert.equal(b.read().length, 2, "the window is a presentation bound");
      assert.deepEqual(
        b.grep("row 1").map((r) => r.entry.id),
        ["b1"],
        "an entry far outside the window stays greppable (DESIGN: rotated segments stay greppable)",
      );
    } finally {
      cleanup(dir);
    }
  });

  it("a miss is an honest empty list, and a term-less query is a usage error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-board-miss-"));
    try {
      const b = board(dir);
      b.write({ type: "FACT", author: "a", room: "mesh", text: "something" });
      assert.deepEqual(b.grep("nothing-matches-this"), []);
      assert.throws(() => b.grep(" , "), /grep_invalid/);
    } finally {
      cleanup(dir);
    }
  });
});
