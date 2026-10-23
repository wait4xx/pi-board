# pi-board — DESIGN (v0.1 slice)

Stage gate for spec package `2026-10-23_build-pi-board-cli`. Everything
below is the agreed shape; deviations require `/spec:update`.

## 0. Maintainer constraints and where they land

The five constraints from the upstream ruling (pi-mesh issue #13) are not
advisory — each maps to a concrete element:

| # | Constraint (issue #13) | Where it lands |
|---|---|---|
| 1 | Reuse observer read-only and the room-member gate ("same class of bug we just fixed in ctl") | §5 gates mirror pi-mesh `routeMsg` semantics; tests assert against the same scenarios (task_0006) |
| 2 | One tool, one action | §6 CLI: five subcommands, one verb each; no multi-action tool ever |
| 3 | `board_read {id}` for detail is fine, but no multi-action board tool | §3.3 `read --id` unfolds `detail`; no other action shares the read path |
| 4 | CLAIM is informational; combine with `mesh_claim` leases — the board never enforces | §3.2 CLAIM carries no authority; README states the information/ enforcement split |
| 5 | FAIL at normal priority; turn-boundary "new FAIL summary line" beats an urgent frame | §5.3 notify = normal-priority broadcast; watch prints the boundary line |

## 1. Shape

`pi-board` is a standalone package: storage, entries, and search live here;
the mesh is a router and never a database. CLI-first (`piboard`), zero
runtime dependencies, `pi-mesh-extension` as an optional peer (minimum
version face decided by the task_0005 spike, spec.md §2.3).

```
src/
  shared/limits.ts   every bound, named (house rule)
  store/             append-only JSONL kernel + rotation + TTL + forbidden keys
  entries/           typed entries, unfold, read window, boolean grep
  mesh/              join (member/observer), gates, notify      (dev12)
  cli/               piboard command surface                    (task_0008)
```

State lives under `$PI_BOARD_STATE_DIR` or `~/.pi-board/`, one directory
per room (`<root>/<room-slug>/`) — v0.1 is single-room, but the path shape
is room-ready so no migration is owed later.

## 2. Storage kernel (task_0003)

**Append-only JSONL segments.** One line per entry; segments are immutable
once rotated (`seg-000001.jsonl`, …); only the newest segment is written.
Rotation triggers on either bound: `SEGMENT_MAX_ENTRIES` (10 000) or
`SEGMENT_MAX_BYTES` (1 MiB). Rotated segments stay greppable — grep
scans the FULL TTL-visible span (the read window is a presentation
bound for `read`, never a search boundary); every byte cap measures the
final stored line, and appends serialize across processes through an
O_EXCL lockfile so ids stay unique.

**Global caps refuse, never evict.** `MAX_ENTRIES` (50 000) and
`MAX_TOTAL_BYTES` (32 MiB): an append past a cap is REFUSED with an honest
error. Silent eviction is a v0.2+ policy question, not a v0.1 behavior.

**TTL.** `ENTRY_TTL_MS` (7 d) is a visibility bound: expired entries are
invisible to read/grep (filter at query time) and physically pruned when a
fully-expired segment rotates. `meta.json` holds the monotonic id counter
and segment bookkeeping; writes to it use tmp+rename (a crash mid-write
corrupts one segment's tail at worst, never the table). Pruning's
"last line expired ⇒ whole segment expired" shortcut assumes a
monotonic wall clock; a clock rollback of TTL magnitude can misjudge a
segment (entries merely become invisible-per-query — nothing readable is
silently dropped, and a torn tail line is never pruned, only skipped).

**Env overrides (gate review a).** Every bound in `src/shared/limits.ts`
can be tightened or widened by the operator via `PI_BOARD_<NAME>` env
vars (e.g. `PI_BOARD_ENTRY_TTL_MS` — 7 d is tight for long task lines,
and TTL bounds the searchable span). Parsing is fail-closed: an
unusable value (non-numeric, ≤ 0) is a startup error naming the
variable, never a silent fallback.

**Forbidden keys, fail-closed.** The write path scans `text` AND `detail`
against `FORBIDDEN_KEY_PATTERNS` (secret shapes: cloud keys, tokens,
private-key blocks — the pi-mesh ledger's pattern class). A match refuses
the append; a scan failure (unreadable/invalid state) also refuses — the
board must never persist what it could not prove clean.

**Id scheme.** Monotonic per-board: `b<seq36>` from the meta counter.
Readable, sortable, collision-free without coordination.

## 3. Entries (task_0004)

### 3.1 The five types (closed set)

`OBSERVED` — something seen, no commitment · `FACT` — verified truth ·
`FAIL` — a falsified path: what was tried, why it failed · `CLAIM` — an
informational ownership note (pairs with `mesh_claim`; no authority here) ·
`PATCH_SUMMARY` — what a landed change did. Unknown types are rejected at
write time (closed enum, no free-form `type`).

### 3.2 Shape

```
{ id, type, author, room, at, text, detail?, ref?, leaseRef? }
```

(Erratum, review round: the original draft listed a `claimId?` field that
was never implemented — `ref` covers git-reachable anchoring, and the
claim↔lease correlation is `leaseRef`. The shipped surface exposes it via
`piboard write --lease-ref`.)

- `text` — the summary line, ≤ `MAX_TEXT_CHARS` (280 BYTES — the bounds
  are byte bounds, not UTF-16 units); always present,
  always short: summaries must survive a turn boundary by being cheap to read.
- `detail` — optional long form, ≤ `MAX_DETAIL_CHARS` (8 KiB bytes, read
  bounded at ingestion); stored at
  write time, surfaced only by `read --id` (constraint #3). `write` takes
  it via `--detail-file` or stdin (never an unbounded argv blob).
- `ref` — optional git-reachable anchor (path, commit, URL).
- Entries may carry `leaseRef` (the `mesh_claim` lease id) — pure
  annotation for correlation; enforcement never lives here (constraint #4).

### 3.3 Read and grep

- `read` returns the newest window, default `READ_WINDOW_DEFAULT` (2 000)
  capped by `READ_WINDOW_MAX`; one-line summaries only.
- `read --id <id>` unfolds that entry's `detail`.
- `grep "a,b & c"` — `,` = OR, `&` = AND, case-insensitive substring over
  `text` and `detail`; precedence: AND binds tighter than OR (same as
  search-engine convention). A miss returns an honest empty list —
  exit 0 with zero rows, never an error, never invented rows. Every row
  always carries the entry `id`; a hit found only in `detail` is marked
  `(in detail)` — a summary line that hides the match must not confuse,
  and `read --id` is the natural follow-up (gate review b).

## 4. Search semantics summary

| Query | Matches |
|---|---|
| `foo` | text or detail contains foo (ci) |
| `foo,bar` | foo OR bar |
| `foo&bar` | foo AND bar |
| `foo,bar&baz` | foo OR (bar AND baz) |

## 5. Mesh (dev12, phase 2 — shape only here)

### 5.1 Join

The board joins as a normal peer under alias `board` (or `PI_BOARD_ALIAS`),
one room; member by default, `--observer` opts into read-only. Alias/room/
policy semantics are exactly a normal pi-mesh peer's — no special casing.

### 5.2 Gates (constraint #1)

- observer ⇒ every write path refused (`observer_readonly`), reads fine;
- not a room member ⇒ refused (`not_a_member`) — semantics asserted against
  pi-mesh `routeMsg`'s own room-member checks in task_0006's tests;
- member ⇒ write proceeds through the storage kernel's own validation.

### 5.3 Notify (constraint #5)

A successful write emits ONE normal-priority broadcast frame to the room:
type + id + the short text; `detail` never travels (bounded frames only).
`watch` renders the turn-boundary "new FAIL summary line" for FAIL entries
since the last boundary — cheap, skimmable, no urgent priority ever.

## 6. CLI surface (task_0008 — one verb per subcommand, constraint #2)

```
piboard join <room> [--observer]
piboard watch
piboard write --type FAIL --text "…" [--detail-file -|PATH] [--ref R]
piboard read [--id ID] [--limit N]
piboard grep "a,b&c"
```

Honest exit codes (pi-mesh CLI convention): 0 ok · 1 error · 2 usage ·
3 not_found (`read --id` unknown id) · 4 refused (observer/non-member
write attempt). A grep miss is exit 0 with empty output.

## 7. Test strategy

- Kernel (store/entries): unit + edge tests against real files in mkdtemp
  dirs — rotation, caps, TTL, forbidden keys, window truncation, boolean
  algebra truth tables.
- Mesh: real broker, real sockets, real processes (join/gates/notify).
- Platform differences: visible `skip` with reason (the T11/T13 lesson —
  never a silent early-return).
- `npm run smoke` (task_0009): true broker + two fake peers, full chain
  join → write → broadcast → read → grep → observer refused.

## 8. Out of scope (v0.1)

Broker-side storage (permanent red line) · extension tool registration ·
multi-room indexes · per-entry ACLs · urgent FAIL delivery · GUIs ·
multi-machine distributed grep (v0.2+) · eviction policies (caps refuse
instead) · grep over rotated-away (pruned) history.
