# pi-board

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/wait4xx/pi-board/actions/workflows/ci.yml/badge.svg)](https://github.com/wait4xx/pi-board/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)
![Platform](https://img.shields.io/badge/platform-Linux%20tested-lightgrey.svg)
![Ecosystem](https://img.shields.io/badge/ecosystem-pi--mesh-8A2BE2.svg)

**A shared context board for pi-mesh rooms — typed entries, bounded
honest storage, boolean full-text search. The mesh stays a router,
never a database.**

## Overview

A pi-mesh room already has messages (`mesh_send`) and a workspace (git +
`mesh_reserve`). pi-board is the missing third pillar: durable, searchable
**shared context**. Five typed entry kinds:

| Type | Meaning |
|---|---|
| `OBSERVED` | something seen — no commitment |
| `FACT` | verified truth |
| `FAIL` | a falsified path — searchable so the whole room stops re-burning budget on it |
| `CLAIM` | informational ownership note, paired with `mesh_claim` leases (the board never enforces) |
| `PATCH_SUMMARY` | what a landed change did |

The board keeps a bounded append-only local store and answers boolean
queries; it joins the mesh as a normal peer (member or read-only
observer) and announces writes as normal-priority broadcast frames.
**No storage ever goes into the broker.**

Design contract: [DESIGN.md](DESIGN.md) · delivery reconciliation:
[docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md) · contributing:
[CONTRIBUTING.md](CONTRIBUTING.md).

## The pi-mesh stack

pi-board is one layer of a small stack of cooperating tools:

```
 the pi-mesh stack
 ┌───────────────────────────────────────────────────────────────┐
 │ pi-mesh    messages · routing · rooms · policy · leases       │
 │            github.com/cgarrot/pi-mesh                         │
 ├───────────────────────────────────────────────────────────────┤
 │ pi-board   shared context — this package                      │
 ├───────────────────────────────────────────────────────────────┤
 │ pi-jobd    background execution + orphan adoption             │
 │            github.com/cgarrot/pi-jobd  (newborn: v0.1.0)      │
 └───────────────────────────────────────────────────────────────┘
 pi-subagents — worker control on top of the mesh (companion tool)
```

- **[pi-mesh](https://github.com/cgarrot/pi-mesh)** — the backbone:
  messages, routing, rooms, policy, capability routing and task leases.
- **pi-board** (this repo) — the room's shared context: typed entries,
  honest bounded storage, boolean search. No broker-side storage.
- **[pi-jobd](https://github.com/cgarrot/pi-jobd)** — detached
  background jobs with honest states and orphan adoption after daemon
  restarts (a newborn at v0.1.0; early days, Windows still
  experimental).
- **pi-subagents** — worker control on top of the mesh (spawn, steer,
  follow up, abort).

They compose: **discoveries land on the board**, conversation moves over
the **mesh**, long work is handed to **jobd**, and exclusivity is a
**`mesh_claim` lease** annotated by a **CLAIM entry**. For example:

```text
mesh_send  → "who has looked at the TLS failures?"        (conversation)
board_grep → "tls"  → FAIL b17: handshake cert mismatch    (shared memory)
mesh_run   → hand the rebuild to pi-jobd (background)        (long work)
mesh_claim → { task: "rebuild", paths: ["dist/"] }          (exclusivity)
board_write→ CLAIM "rebuild is mine" --lease-ref <leaseId>  (correlation)
```

The design lineage traces to the Agensh/DeLM thread on pi-mesh
issue #13 — the full design story lives there and in [DESIGN.md](DESIGN.md);
this section only maps the neighborhood.

## Install

From source (the package is not on npm yet — no dead badge until it is):

```bash
git clone https://github.com/wait4xx/pi-board.git
cd pi-board
npm ci            # or: npm install
npm run build
```

Two modes of use:

- **CLI only** — works with zero peer dependencies; every command except
  `join` runs against the local store (`--room` needs no mesh at all).
- **With a mesh** — install `pi-mesh-extension` alongside (any version
  with the client core; the verified face spans 0.7.2–0.10.2). The board
  never vendors or forks it; there is no broker-side component.

Requirements: Node ≥ 20, zero runtime dependencies, Linux is the tested
platform.

## CLI reference

```
piboard join <room> [--observer] [--alias A]
piboard write --type T --text "…" [--detail-file -|PATH] [--ref R] [--lease-ref L]
piboard read [--id ID] [--limit N] [--room ROOM]
piboard grep "a,b&c" [--type T] [--limit N] [--room ROOM]
piboard watch
piboard help [cmd]
```

| Command | What it does |
|---|---|
| `join` | become the room's board **presence**: the only announcer. A watermark-resumed loop broadcasts entries newer than its persisted cursor — including entries written while the presence was down (nothing silently lost, nothing replayed). |
| `write` | append one typed entry. Requires a joined role — the write gate's premise is a configured identity. `--detail-file -` reads bounded stdin (interactive terminals are refused instead of hanging). |
| `read` | newest window, or `--id` to unfold one entry's `detail` (the only path detail takes to a reader). `--room` / `$PI_BOARD_ROOM` enable store-only reads with no join at all. |
| `grep` | boolean search over `text` AND `detail`, full TTL-visible span (rotated segments included). Miss = exit 0, empty output. |
| `watch` | prints the turn-boundary `⚠ board: N new FAIL — …` line as new FAILs land (joined room only — a boundary digest is a presence behavior). |

Exit codes: `0` ok (a grep miss included) · `1` error · `2` usage ·
`3` not_found (`read --id` unknown) · `4` refused (observer / non-member
write attempt).

Examples:

```bash
piboard join mesh --observer
piboard write --type FAIL --text "port probe 13389 hangs" --detail-file -
piboard read --id b7
piboard grep "timeout,firewall&tls" --type FAIL --limit 5
PI_BOARD_STATE_DIR=/tmp/demo piboard read --room mesh     # store-only, no join
```

Environment: `PI_BOARD_STATE_DIR` (state root, default `~/.pi-board`),
`PI_BOARD_ALIAS` (peer alias, default `board`), `PI_BOARD_ROOM`
(read-command room fallback), `PI_BOARD_OBSERVER=true` (force observer —
the fail-safe direction only), plus one `PI_BOARD_<LIMIT>` override per
bound (e.g. `PI_BOARD_ENTRY_TTL_MS`; invalid values are startup errors
naming the variable).

## Extension tools (v0.2)

Loaded as a Pi extension, the board exposes four single-action tools:

| Tool | Action |
|---|---|
| `board_write` | append a typed entry (same validation and gate as the CLI) |
| `board_read` | window read, or `{ id }` to unfold detail |
| `board_grep` | boolean search with `type` / `limit` filters |
| `board_watch` | skim the room's recorded failures |

The extension **auto-joins as an observer by default** — read-only until
`piboard join` writes an explicit member config. `$PI_BOARD_OBSERVER=true`
can force observer even over a member config (fail-safe direction only,
never the reverse). On machines with no broker it never spawns one
(`MESH_NO_AUTO_BROKER` during the connect window); a dead peer is
recovered automatically; announces are room-tagged.

## Design in one page

**Storage (append-only, honest by construction).** JSONL segments rotate
on a dual bound (entries/bytes); rotated segments are immutable and stay
greppable. Global caps **refuse, never evict** — a referenced id must not
silently vanish. TTL is a visibility bound (queries filter; physical
pruning happens only when a fully-expired segment rotates; a torn tail
line is skipped, never a write-path failure). Secret shapes fail closed
at the scan; byte bounds measure the final stored line; appends serialize
across processes via an O_EXCL lockfile so ids stay unique.

**Search.** `,` = OR, `&` = AND (AND binds tighter), case-insensitive
substring over `text` and `detail`:

| Query | Matches |
|---|---|
| `foo` | text or detail contains foo (ci) |
| `foo,bar` | foo OR bar |
| `foo&bar` | foo AND bar |
| `foo,bar&baz` | foo OR (bar AND baz) |

Every row carries the entry id; a hit found only in `detail` is marked
`(in detail)` — `read --id` is the natural follow-up.

**Gates & security model.** Same-user trust boundary (0600 endpoint,
0600 records). Write paths check membership before observer role,
mirroring pi-mesh `routeMsg`'s order, and decide on the **configured**
identity — never on broker state — so a reconnect-role drift cannot open
a write path. The mesh never carries a shell string: announce frames are
closed-shape (type + id + short text), normal priority only.

**Announce architecture.** One presence (`piboard join`) owns the peer
connection and is the only announcer — a watermark-resumed loop that
also covers entries written while it was down. One-shot writes never
connect (no alias collision); `watch` renders the turn-boundary FAIL
digest. FAIL is deliberately **normal** priority: a boundary summary
line beats an urgent frame.

## CLAIM ↔ mesh_claim

A `CLAIM` entry (optionally `--lease-ref`) is the **information layer**;
`mesh_claim` is the **enforcement layer**. The board records who claimed
what, when, and correlates the lease id — it never blocks, gates, or
expires anything.

## Scale expectations

Queries scan the TTL-visible span (bounded by the caps: ≤ 50 000 entries
/ 32 MiB on disk), not indexed — deliberate for a local single-room
board. Past tens of thousands of live entries, grep latency degrades
linearly. Indexes and multi-machine search are future territory.

## Measured at closeout

At commit `dad72c4` (Linux, Node 22), re-runnable from a clean clone:

| Claim | Evidence |
|---|---|
| strict build, zero errors | `npm run build --silent` → exit 0 |
| 75 tests / 0 fail / 0 skipped | `npm test` → `# tests 75 / pass 75 / fail 0 / skipped 0` |
| 11-step smoke on a real broker | `npm run smoke` → `smoke: 11/11 ok, 0 skipped` (join → write → broadcast → read → grep → observer refused → exactly-one-frame → auto-join observer → member upgrade → …) |

Every number above was run at the cited tree before being written down;
[docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md) holds the full trail.

## Roadmap

Deliberately out of scope today: broker-side storage (permanent red
line), multi-room indexes, per-entry ACLs, urgent FAIL delivery, GUIs.

v0.3+ candidates, in rough order of value: multi-machine search (grep
federation across boards), an index for large spans, the urgent-FAIL
question (does any room actually need it above a boundary line?), and
watch cursors shared between CLI and extension. Nothing here is
promised; scope changes go through the spec process.

## FAQ

**Why is observer the auto-join default?**
Because a read-only mistake is recoverable and a write-path mistake is
not. An extension that joins silently should be able to READ the room's
context immediately, but never surprise it with writes. Member power
requires the explicit, human-visible act of `piboard join`.

**Why does a daemon announce instead of each write connecting itself?**
Two reasons: an alias collision (a one-shot write connecting under the
presence's alias would fight it), and completeness — the presence's
watermark loop announces entries written by ANY process while it watches,
including ones written while it was down. Per-write connects would only
ever cover the CLI's own writes.

**Why do caps refuse instead of evicting old entries?**
Because eviction makes referenced ids vanish: a board entry cited in a
conversation (`read --id b42`) must not 404 because a cap rotated it
away. Refusal is loud, honest, and the operator's call (widen a bound,
or archive a segment — segments are plain JSONL).

**The CLI says `board config unreadable … fix or remove it`. What happened?**
`board.json` (written by `piboard join`) exists but is not valid JSON or
is missing fields — often a partially written file after a crash. Fix the
file or delete it and re-join; the CLI reports the exact path and problem
instead of misleading you with "not joined".

## License

MIT — see [LICENSE](LICENSE).
