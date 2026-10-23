/**
 * src/store/store.ts — the append-only board kernel: JSONL segments,
 * rotation, caps that refuse (never evict), TTL visibility, and a
 * fail-closed forbidden-key scan.
 *
 * Why segments: a crash mid-write corrupts one segment's tail at worst,
 * never the whole table; rotated segments are immutable and stay
 * greppable. `meta.json` (tmp+rename) holds the id counter — the id is
 * reserved BEFORE the data write, so a crash between the two leaves a gap,
 * never a duplicate.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FORBIDDEN_KEY_PATTERNS, loadLimits, type Limits } from "../shared/limits.js";

const SEGMENT_GLOB = /^seg-(\d{6})\.jsonl$/;

/** A lock holder older than this is a crashed writer — break its lock. */
const APPEND_LOCK_STALE_MS = 10_000;

/** Anything the board stores: an id, a timestamp, then caller fields. */
export interface StoredEntry {
  id: string;
  at: string;
  [field: string]: unknown;
}

export class BoardFullError extends Error {
  constructor(
    readonly bound: "maxEntries" | "maxTotalBytes",
    message: string,
  ) {
    super(message);
    this.name = "BoardFullError";
  }
}

export class ForbiddenKeyError extends Error {
  constructor(readonly patternIndex: number) {
    // Name the pattern, never the matched text — the error must not echo
    // the secret it refused.
    super(`forbidden_key: entry matches secret pattern #${patternIndex}; refusing to persist`);
    this.name = "ForbiddenKeyError";
  }
}

export interface StoreOptions {
  limits?: Limits;
  /** Clock injection for tests (defaults to Date.now). */
  now?: () => number;
}

/** `<root>/<room>/`; root = `$PI_BOARD_STATE_DIR` or `~/.pi-board`. */
export function boardDir(room: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_BOARD_STATE_DIR;
  const root = override !== undefined && override !== "" ? override : join(homedir(), ".pi-board");
  return join(root, room);
}

export class BoardStore {
  readonly dir: string;
  readonly limits: Limits;
  private readonly now: () => number;
  private seq: number;

  constructor(dir: string, opts: StoreOptions = {}) {
    this.dir = dir;
    this.limits = opts.limits ?? loadLimits();
    this.now = opts.now ?? Date.now;
    mkdirSync(join(dir, "segments"), { recursive: true, mode: 0o700 });
    this.seq = this.loadMeta().seq;
  }

  // ---- write path ----

  /**
   * Persist one entry. Validation order matters: the forbidden-key scan and
   * field caps run BEFORE any counter reservation or write, so a refused
   * append leaves no trace (no id gap, no partial line).
   */
  append(draft: Record<string, unknown>): StoredEntry {
    this.scanForbiddenKeys(draft);
    // Field caps are BYTE bounds (DESIGN says "8 KiB", not 8192 UTF-16 units).
    const text = draft["text"];
    if (typeof text === "string" && Buffer.byteLength(text, "utf8") > this.limits.maxTextChars) {
      throw new Error(`entry_too_long: text exceeds ${this.limits.maxTextChars} bytes`);
    }
    const detail = draft["detail"];
    if (typeof detail === "string" && Buffer.byteLength(detail, "utf8") > this.limits.maxDetailChars) {
      throw new Error(`entry_too_long: detail exceeds ${this.limits.maxDetailChars} bytes`);
    }
    const draftLine = `${JSON.stringify(draft)}\n`;
    if (Buffer.byteLength(draftLine) > this.limits.segmentMaxBytes) {
      // Fast-fail on the draft line; the authoritative check below measures
      // the FINAL line (id+at add ~40-60 bytes).
      throw new Error(`entry_too_large: single entry exceeds the segment bound (${this.limits.segmentMaxBytes} bytes)`);
    }
    return this.withAppendLock(() => {
      // Cross-process serialization: re-read the counter under the lock so
      // concurrent CLI processes never both write b(N+1).
      this.seq = this.loadMeta().seq;
      const physical = this.physicalStats();
      if (physical.entries + 1 > this.limits.maxEntries) {
        throw new BoardFullError(
          "maxEntries",
          `board_full: ${physical.entries} entries on disk, cap ${this.limits.maxEntries} — append refused (never silently evicted)`,
        );
      }

      // Build the FINAL line, then measure every byte bound against it.
      const entry: StoredEntry = {
        ...draft,
        id: `b${(this.seq + 1).toString(36)}`,
        at: new Date(this.now()).toISOString(),
      };
      const finalLine = `${JSON.stringify(entry)}\n`;
      const finalBytes = Buffer.byteLength(finalLine);
      if (finalBytes > this.limits.segmentMaxBytes) {
        throw new Error(`entry_too_large: single entry exceeds the segment bound (${this.limits.segmentMaxBytes} bytes)`);
      }
      if (physical.bytes + finalBytes > this.limits.maxTotalBytes) {
        throw new BoardFullError(
          "maxTotalBytes",
          `board_full: ${physical.bytes} bytes on disk, cap ${this.limits.maxTotalBytes} — append refused (never silently evicted)`,
        );
      }

      // Persist the reservation BEFORE the data write: a crash between the
      // two leaves a harmless id gap, never a duplicate after reopen. A
      // refusal above simply never persists — the id is reused cleanly.
      this.seq += 1;
      this.saveMeta();
      appendFileSync(this.targetSegmentPath(finalBytes), finalLine, "utf8");
      return entry;
    });
  }

  /**
   * Serialize appends across processes with an O_EXCL lockfile. A crash
   * while holding it leaves a stale file; a holder older than the stale
   * bound is broken (the write either landed or never happened — meta is
   * tmp+rename atomic, so breaking cannot corrupt the table).
   */
  private withAppendLock<T>(fn: () => T): T {
    const lockPath = join(this.dir, "append.lock");
    for (;;) {
      let fd: number | undefined;
      try {
        fd = openSync(lockPath, "wx", 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > APPEND_LOCK_STALE_MS) {
            unlinkSync(lockPath);
          }
        } catch {
          // raced away or unreadable — the retry loop handles both
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      try {
        return fn();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          // best effort
        }
      }
    }
  }

  /**
   * The segment the next line goes to: the current one while it is under
   * both bounds, the NEXT one (rotation) once either is hit. Rotated
   * segments are never reopened for writing — immutability by construction.
   * On rotation, every OLD segment whose newest line is TTL-expired is
   * fully expired (segments are chronological) and pruned physically.
   */
  private targetSegmentPath(incomingBytes: number): string {
    const names = this.segmentNames();
    const lastName = names[names.length - 1];
    if (lastName === undefined) return join(this.dir, "segments", "seg-000001.jsonl");
    const lastPath = join(this.dir, "segments", lastName);
    const entries = this.countLines(lastPath);
    const size = statSync(lastPath).size;
    const rotate = entries >= this.limits.segmentMaxEntries || size + incomingBytes > this.limits.segmentMaxBytes;

    if (rotate) {
      for (const name of names) {
        if (name === lastName) continue;
        const path = join(this.dir, "segments", name);
        let lastAt: string | undefined;
        try {
          const lines = readFileSync(path, "utf8").trimEnd().split("\n");
          lastAt = (JSON.parse(lines[lines.length - 1] ?? "{}") as { at?: string }).at;
        } catch {
          // A torn tail line (crash mid-append) is unparseable: treat the
          // segment as NOT fully expired and move on. Query-side TTL
          // filtering already hides expired entries; pruning must never
          // become a write-path failure that outlives the crash (a parse
          // throw here would refuse every future rotation-triggering append).
          continue;
        }
        if (lastAt !== undefined && this.isExpired(lastAt)) {
          try {
            unlinkSync(path);
          } catch {
            // best effort: an unprunable segment stays invisible to queries
          }
        }
      }
      const next = Number.parseInt(lastName.slice(4, 10), 10) + 1;
      return join(this.dir, "segments", `seg-${String(next).padStart(6, "0")}.jsonl`);
    }
    return lastPath;
  }

  // ---- read path ----

  /** Newest-first window of TTL-visible entries. */
  read(limit = this.limits.readWindowDefault): StoredEntry[] {
    const out: StoredEntry[] = [];
    for (const entry of this.scanVisible()) {
      out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  }

  byId(id: string): StoredEntry | undefined {
    for (const entry of this.scanVisible()) {
      if (entry.id === id) return entry;
    }
    return undefined;
  }

  /**
   * Case-insensitive substring scan over `text` and `detail`, newest-first.
   * The boolean algebra and output shaping live in the entries layer; this
   * proves the primitive every segment (rotated or not) stays searchable.
   */
  grepSubstr(term: string): Array<{ entry: StoredEntry; inDetail: boolean }> {
    const needle = term.toLowerCase();
    const out: Array<{ entry: StoredEntry; inDetail: boolean }> = [];
    for (const entry of this.scanVisible()) {
      const text = typeof entry.text === "string" ? entry.text : "";
      const detail = typeof entry.detail === "string" ? entry.detail : "";
      if (text.toLowerCase().includes(needle)) out.push({ entry, inDetail: false });
      else if (detail.toLowerCase().includes(needle)) out.push({ entry, inDetail: true });
    }
    return out;
  }

  /** Physical on-disk reality (caps accounting): lines and bytes. */
  physicalStats(): { entries: number; bytes: number } {
    let entries = 0;
    let bytes = 0;
    for (const name of this.segmentNames()) {
      const path = join(this.dir, "segments", name);
      bytes += statSync(path).size;
      entries += this.countLines(path);
    }
    return { entries, bytes };
  }

  // ---- internals ----

  private isExpired(at: string): boolean {
    const t = Date.parse(at);
    return Number.isFinite(t) && t + this.limits.entryTtlMs < this.now();
  }

  /** Newest-first iteration of TTL-visible entries across all segments. */
  private *scanVisible(): Generator<StoredEntry> {
    const names = this.segmentNames(); // ascending
    for (let i = names.length - 1; i >= 0; i -= 1) {
      const raw = readFileSync(join(this.dir, "segments", names[i]!), "utf8");
      const lines = raw.split("\n");
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        const line = lines[j]!.trim();
        if (line === "") continue;
        let entry: StoredEntry;
        try {
          entry = JSON.parse(line) as StoredEntry;
        } catch {
          continue; // a torn tail line from a crash is skipped, never fatal
        }
        if (typeof entry.id !== "string" || typeof entry.at !== "string") continue;
        if (this.isExpired(entry.at)) continue;
        yield entry;
      }
    }
  }

  private segmentNames(): string[] {
    try {
      return readdirSync(join(this.dir, "segments"))
        .filter((name) => SEGMENT_GLOB.test(name))
        .sort();
    } catch {
      return [];
    }
  }

  private countLines(path: string): number {
    const raw = readFileSync(path, "utf8");
    let count = 0;
    for (const line of raw.split("\n")) if (line.trim() !== "") count += 1;
    return count;
  }

  /**
   * Fail-closed forbidden-key scan: every string value in the draft is
   * tested against every pattern. A match refuses; a draft that cannot be
   * scanned or serialized also refuses — the board never persists what it
   * could not prove clean.
   */
  private scanForbiddenKeys(value: unknown, seen = 0): void {
    if (seen > 8) {
      // Fail-closed, literally: a structure too deep to scan is refused,
      // not silently passed (the board never persists what it could not
      // prove clean).
      throw new Error("entry_invalid: nesting deeper than 8 levels cannot be scanned — refusing");
    }
    if (typeof value === "string") {
      for (let i = 0; i < FORBIDDEN_KEY_PATTERNS.length; i += 1) {
        if (FORBIDDEN_KEY_PATTERNS[i]!.test(value)) throw new ForbiddenKeyError(i);
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const child of Object.values(value as Record<string, unknown>)) {
      this.scanForbiddenKeys(child, seen + 1);
    }
  }

  // ---- meta (id counter) ----

  private metaPath(): string {
    return join(this.dir, "meta.json");
  }

  private loadMeta(): { seq: number } {
    try {
      const raw = JSON.parse(readFileSync(this.metaPath(), "utf8")) as { seq?: unknown };
      if (typeof raw.seq === "number" && Number.isInteger(raw.seq) && raw.seq >= 0) return { seq: raw.seq };
    } catch {
      // absent or corrupt meta: start from the highest id on disk, so ids
      // stay unique even after a crash between reservation and write.
    }
    let seq = 0;
    for (const entry of this.scanAllRawIds()) {
      const n = Number.parseInt(entry.id.slice(1), 36);
      if (Number.isFinite(n) && n > seq) seq = n;
    }
    return { seq };
  }

  private saveMeta(): void {
    const target = this.metaPath();
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ seq: this.seq, version: 1 })}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target);
  }

  /** Physical ids, oldest-first, ignoring TTL (id-reconciliation only). */
  private *scanAllRawIds(): Generator<StoredEntry> {
    for (const name of this.segmentNames()) {
      const raw = readFileSync(join(this.dir, "segments", name), "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const entry = JSON.parse(trimmed) as StoredEntry;
          if (typeof entry.id === "string") yield entry;
        } catch {
          // torn tail line: skip
        }
      }
    }
  }
}
