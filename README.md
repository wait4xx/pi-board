# pi-board — shared context board for pi-mesh

**Status: design stage — spec slice `2026-10-23_build-pi-board-cli`.**

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

## Explicitly out of scope for v0.1

Broker-side storage (permanent red line), pi-mesh extension tool
registration, multi-room indexes, per-entry ACLs, urgent FAIL delivery,
GUIs, multi-machine distributed grep.

See `DESIGN.md` (once task_0002 lands) for the design and the maintainer
constraints it follows.
