# pi-board — shared context board for pi-mesh

**Status: v0.1 slice complete (spec package `2026-10-23_build-pi-board-cli`) —
measured at commit `ece67d8` on Node 22 / Linux.**

## Overview

A pi-mesh room has messages (`mesh_send`) and a workspace (git +
`mesh_reserve`) — pi-board adds the missing third pillar: a **shared
context board**. It is a small, zero-runtime-dependency Node package with
five typed entry kinds — `OBSERVED` (something seen), `FACT` (verified
truth), `FAIL` (a falsified path — searchable so the whole room stops
re-burning budget on it), `CLAIM` (informational ownership note, paired
with `mesh_claim` leases — the board never enforces), and
`PATCH_SUMMARY` (what a landed change did).

The board keeps a bounded append-only local store (JSONL segments with
rotation, entry/byte caps that refuse rather than evict, TTL visibility,
and a fail-closed forbidden-key scan) and answers boolean full-text
queries (`,` = OR, `&` = AND, case-insensitive). It is CLI-first
(`piboard`), joins the mesh as a normal peer (member or read-only
observer), announces writes as normal-priority broadcast frames, and puts
NO storage in the broker — the mesh stays a router, never a database.

Design and maintainer constraints: see [DESIGN.md](DESIGN.md).
Delivery reconciliation (every number below with its command, output and
commit): see [docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md).

## Measured at v0.1 closeout (`ece67d8`, Linux, Node 22)

| Claim | Evidence (re-runnable) |
|---|---|
| strict build, zero errors | `npm run build --silent` → exit 0, no output |
| 55 tests, 0 fail, 0 skipped | `npm test` → `# tests 55 / pass 55 / fail 0 / skipped 0` |
| 9-step smoke on a real broker | `npm run smoke` → `smoke: 9/9 ok, 0 skipped` (join → write → broadcast → read → grep → observer refused → exactly-one-frame …) |

## Scale expectations (v0.1)

Queries (read/grep/byId) scan the TTL-visible span — bounded by the caps
(≤ 50 000 entries / 32 MiB on disk), not indexed. That is deliberate for
a local single-room CLI; if a room's board grows past tens of thousands
of live entries, grep latency degrades linearly. Indexes and multi-machine
search are v0.2+ territory (see DESIGN §8).

## Explicitly out of scope for v0.1

Broker-side storage (permanent red line), pi-mesh extension tool
registration, multi-room indexes, per-entry ACLs, urgent FAIL delivery,
GUIs, multi-machine distributed grep.

See `DESIGN.md` (once task_0002 lands) for the design and the maintainer
constraints it follows.
