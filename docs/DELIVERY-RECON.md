# DELIVERY-RECON — v0.1 slice closeout reconciliation

Every externally repeated number/claim in README.md and the pi-mesh #13
reply draft traces to a measurement below. All commands re-runnable from a
clean clone at commit `ece67d8` (Linux, Node 22, `npm ci` first).

## 1. Numbers re-measured (not inherited)

| # | Number | Command | Key output (measured 2026-10-24, `ece67d8`) |
|---|---|---|---|
| N1 | strict build clean | `npm run build --silent; echo $?` | `0` (no diagnostics) |
| N2 | 55 tests / 0 fail / 0 skipped | `npm test` | `# tests 55` `# pass 55` `# fail 0` `# skipped 0` |
| N3 | 9-step real-broker smoke | `npm run smoke` | `smoke: 9/9 ok, 0 skipped` |
| N4 | spec package: 8/8 tasks verified | `spec_verify --all` (coordinator run on the same tree) | 8 tasks OK; fingerprint `3631ff33` (run by the package gate owner, re-runnable from the local `.spec` workspace) |

N1–N3 were re-run by the delivery author immediately before this file was
written; N4 is the coordinator's gate run on the identical tree (their
terminal, same HEAD) — attributed, not assumed.

## 2. Review-round diffs, each with its commit

The independent review found two MAJOR and several MINOR/NIT items; every
fix landed as a separate commit with its own test:

| Finding | Fix | Commit | Test evidence |
|---|---|---|---|
| MAJOR-1 torn tail line crashed prune → write path dead | parse guarded; unparseable tail = "not proven expired", segment skipped | `e318314` | store.test: expired segments pruned, torn segment kept, write survives |
| MAJOR-2 announce watermark reset on join / advanced on failure | resume persisted watermark; advance only on ok; announce errors caught | `c2d61a7` (dev12 lane) | cli tests + smoke step 9 |
| MINOR-1 grep limited to the read window | grep streams the full TTL-visible span | `6f5e307` | entries.test: out-of-window entry greppable |
| MINOR-2 concurrent CLI processes could duplicate ids | O_EXCL lockfile, meta re-read under the lock | `e318314` | store.test: 3 processes × 15 appends → 45 unique ids |
| MINOR-3 LICENSE missing / publish without build | MIT LICENSE + `prepublishOnly` | `3a7a181` | file in tree; script in package.json |
| MINOR-4 --detail-file unbounded read | bounded read at ingestion (stdin: no seek) | `dc41d30` | cli.test: 8193-byte stdin → exit 1, empty store |
| NIT-1 usage/state ordering inconsistent | usage validation precedes role/gate everywhere | `dc41d30` | cli.test: observer board, no-flag write → 2; well-formed → 4 |
| NIT-2 claimId never implemented; leaseRef unreachable | `--lease-ref` flag; DESIGN erratum drops claimId | `dc41d30` + `ece67d8` | cli.test: leaseRef persisted |
| NIT-3 caps measured the id-less draft; UTF-16 units | final-line byte measurement; byte-unit field bounds | `e318314` | store.test: CJK 279 chars → refused; draft-fits-final-refuses |
| NIT-4 clock assumption undocumented | DESIGN §2 states the monotonic-clock assumption | `ece67d8` | docs only |
| NIT-5 exactly-one-frame not asserted | smoke step asserts one broadcast per write | `c2d61a7` lane (smoke) | `npm run smoke` step `[ok] exactly one broadcast frame` |
| NIT-6 deep nesting silently passed the scan | depth > 8 throws (fail-closed) | `e318314` | store.test: 12-level nesting refused |
| NIT-7 performance ceiling unmarked | README § Scale expectations | this delivery | docs only |

## 3. Claim ↔ evidence triangle (external wording → repo truth)

| Claim (README / #13 draft) | Source of truth | Where proven |
|---|---|---|
| "zero runtime dependencies" | package.json `dependencies` absent; only devDeps + optional peer | package.json |
| "five typed entry kinds, closed set" | src/entries/types.ts | entries.test (unknown type refused) |
| "bounded append-only store, refuse-not-evict" | src/store/store.ts | store.test (caps refuse, no trace) |
| "fail-closed forbidden-key scan" | src/store/store.ts | store.test (4 secret shapes refused, no echo) |
| "rotated segments stay greppable" | DESIGN §2 + src/entries/board.ts | entries.test (out-of-window grep) |
| "observer read-only, non-member refused (routeMsg order)" | src/mesh/gates.ts | gates.test + smoke step |
| "normal-priority announce + turn-boundary FAIL line" | src/mesh/notify.ts | notify.test (priority asserted notEqual urgent/force), cli watch test |
| "exit codes 0/1/2/3/4" | src/cli/main.ts | cli.test (all five exercised) |

## 4. Commit triangle for the closeout

- Fix chain: `e318314` → `6f5e307` → `3a7a181` → `dc41d30` → `ece67d8`
  (review round, this lane) preceded by `c2d61a7` (MAJOR-2, adjacent lane).
- All numbers in §1 measured at `ece67d8` = HEAD of this delivery.

## 5. Replay instructions

```bash
git clone <repo> && cd pi-board && git checkout ece67d8
npm ci
npm run build --silent; echo $?        # → 0          (N1)
npm test                               # → 55/55/0/0  (N2)
npm run smoke                          # → 9/9 ok     (N3)
```

Platform note: all numbers above were measured on Linux (Node 22). macOS
and Windows are UNTESTED at v0.1 — nothing in the tree requires a
platform skip today, but no green is claimed where none was measured.
