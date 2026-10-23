// test/entries.test.ts — task_0004: typed entries, read shaping, and the
// boolean grep truth table (DESIGN §3, §4). Real files in hermetic tmp
// dirs — no mocks of the kernel. The full-history test proves grep is
// built on grepSubstr (every segment), NOT on the bounded read window.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  defaultAuthor,
  entryLine,
  grepBoard,
  grepLine,
  isEntryType,
  parseGrepQuery,
  readWindow,
  unfoldById,
  writeEntry,
} from "../src/entries/entries.js";
import { BoardStore } from "../src/store/store.js";
import type { Limits } from "../src/shared/limits.js";

function tmpStore(limits?: Partial<Limits>): { store: BoardStore; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "pi-board-entries-"));
  const full: Limits = {
    segmentMaxEntries: 10_000,
    segmentMaxBytes: 1_048_576,
    maxEntries: 50_000,
    maxTotalBytes: 33_554_432,
    entryTtlMs: 7 * 24 * 60 * 60 * 1_000,
    maxTextChars: 280,
    maxDetailChars: 8_192,
    readWindowDefault: 2_000,
    readWindowMax: 10_000,
    grepLimitDefault: 50,
    ...limits,
  };
  const store = new BoardStore(path.join(root, "room1"), { limits: full });
  return { store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("task_0004: typed entries", () => {
  it("the type set is closed: unknown types are rejected", () => {
    const { store, cleanup } = tmpStore();
    try {
      assert.ok(isEntryType("FAIL"));
      assert.ok(!isEntryType("TODO"));
      assert.throws(
        () => writeEntry(store, { type: "TODO" as never, room: "room1", text: "x" }),
        /invalid_type/,
      );
    } finally {
      cleanup();
    }
  });

  it("empty text is refused; the full shape round-trips", () => {
    const { store, cleanup } = tmpStore();
    try {
      assert.throws(() => writeEntry(store, { type: "FACT", room: "room1", text: "  " }), /missing_text/);
      const e = writeEntry(store, {
        type: "CLAIM",
        room: "room1",
        text: "refactor of notify.ts",
        detail: "long plan",
        ref: "src/mesh/notify.ts",
        claimId: "c1",
        leaseRef: "7f3a",
        author: "tester",
      });
      assert.equal(e.type, "CLAIM");
      assert.equal(e.author, "tester");
      assert.equal(e.room, "room1");
      assert.match(e.id, /^b1$/);
      const unfolded = unfoldById(store, e.id);
      assert.equal(unfolded?.detail, "long plan");
      assert.equal(unfolded?.leaseRef, "7f3a");
    } finally {
      cleanup();
    }
  });

  it("read window is newest-first; entryLine is one skimmable line", () => {
    const { store, cleanup } = tmpStore();
    try {
      writeEntry(store, { type: "OBSERVED", room: "r", text: "first", author: "a" });
      writeEntry(store, { type: "FACT", room: "r", text: "second", author: "a" });
      const win = readWindow(store, 10);
      assert.equal(win.length, 2);
      assert.equal(win[0]!.text, "second"); // newest first
      assert.match(entryLine(win[0]!), /^b\d+ FACT a: second$/);
    } finally {
      cleanup();
    }
  });

  it("defaultAuthor: explicit > $PI_BOARD_AUTHOR > OS user", () => {
    assert.equal(defaultAuthor({ PI_BOARD_AUTHOR: "explicit" } as NodeJS.ProcessEnv), "explicit");
    assert.ok(defaultAuthor({} as NodeJS.ProcessEnv).length > 0);
  });
});

describe("task_0004: boolean grep (, = OR, & = AND, AND binds tighter)", () => {
  it("parseGrepQuery: `foo,bar&baz` → [ [foo], [bar, baz] ]", () => {
    assert.deepEqual(parseGrepQuery("foo,bar&baz"), { groups: [["foo"], ["bar", "baz"]] });
    assert.deepEqual(parseGrepQuery("  Foo & BAR "), { groups: [["foo", "bar"]] });
    assert.throws(() => parseGrepQuery(",,&"), /invalid_query/);
  });

  it("truth table over text + detail, case-insensitive (DESIGN §4)", () => {
    const { store, cleanup } = tmpStore();
    try {
      writeEntry(store, { type: "FAIL", room: "r", text: "monkey-patch of fs gives EBUSY", author: "a" });
      writeEntry(store, { type: "FACT", room: "r", text: "server listens on :4311", author: "a" });
      writeEntry(store, { type: "OBSERVED", room: "r", text: "flaky retry", detail: "the EBUSY error came back twice", author: "a" });
      const texts = (q: string) => grepBoard(store, q).map((row) => row.entry.text);
      // single term, case-insensitive — matches text AND detail, newest first:
      // "EBUSY" lives in the monkey entry's text AND the flaky entry's detail
      assert.deepEqual(texts("EBUSY"), ["flaky retry", "monkey-patch of fs gives EBUSY"]);
      assert.deepEqual(texts("ebusy"), ["flaky retry", "monkey-patch of fs gives EBUSY"]);
      // OR
      assert.deepEqual(texts("4311,flaky"), ["flaky retry", "server listens on :4311"]);
      // AND within one entry
      assert.deepEqual(texts("retry&ebusy"), ["flaky retry"]); // text + detail
      assert.deepEqual(texts("4311&ebusy"), []); // different entries
      // precedence: monkey OR (4311 AND retry) → monkey only
      assert.deepEqual(texts("monkey,4311&retry"), ["monkey-patch of fs gives EBUSY"]);
      // detail-only hit is marked; text hit is not
      const marked = grepBoard(store, "came back twice");
      assert.equal(marked.length, 1);
      assert.equal(marked[0]!.inDetail, true);
      assert.match(grepLine(marked[0]!), /\(in detail\)$/);
      const plain = grepBoard(store, "flaky retry");
      assert.equal(plain[0]!.inDetail, false);
      assert.ok(!grepLine(plain[0]!).includes("(in detail)"));
      // an AND satisfied only through detail still matches
      assert.deepEqual(texts("retry&came back"), ["flaky retry"]);
      // miss = honest empty, never an error
      assert.deepEqual(texts("nothing-matches"), []);
    } finally {
      cleanup();
    }
  });

  it("grep reaches FULL history, not the bounded read window", () => {
    const { store, cleanup } = tmpStore({ readWindowDefault: 3, readWindowMax: 3 });
    try {
      for (let i = 0; i < 6; i += 1) {
        writeEntry(store, { type: "OBSERVED", room: "r", text: `observation numero ${i}`, author: "a" });
      }
      const win = readWindow(store, 3);
      assert.equal(win.length, 3);
      assert.ok(!win.some((e) => e.text.includes("numero 0"))); // oldest is past the window
      const hit = grepBoard(store, "numero 0");
      assert.equal(hit.length, 1); // ...but grep still finds it
      assert.match(hit[0]!.entry.text, /numero 0$/);
    } finally {
      cleanup();
    }
  });

  it("--type filter and limit bound the result; default limit from limits", () => {
    const { store, cleanup } = tmpStore({ grepLimitDefault: 2 });
    try {
      for (let i = 0; i < 5; i += 1) writeEntry(store, { type: "FAIL", room: "r", text: `ebusy attempt ${i}`, author: "a" });
      writeEntry(store, { type: "FACT", room: "r", text: "ebusy explained", author: "a" });
      assert.equal(grepBoard(store, "ebusy", { type: "FAIL", limit: 10 }).length, 5);
      assert.equal(grepBoard(store, "ebusy", { type: "FACT", limit: 10 }).length, 1);
      assert.equal(grepBoard(store, "ebusy").length, 2); // named default, no flag
      assert.equal(grepBoard(store, "ebusy", { limit: 3 }).length, 3);
    } finally {
      cleanup();
    }
  });
});
