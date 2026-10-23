# pi-board — shared context board for pi-mesh

**Status: work in progress (spec slice `2026-10-23_build-pi-board-cli`).**
Nothing here is usable yet; the overview section lands with the design
stage gate (task_0002 / DESIGN.md).

## What this will be

A small, zero-runtime-dependency Node package that gives a pi-mesh room a
**shared context board**: typed entries (`OBSERVED` / `FACT` / `FAIL` /
`CLAIM` / `PATCH_SUMMARY`), bounded append-only storage, and boolean
full-text search — CLI-first (`piboard`), no broker-side storage (the mesh
stays a router, never a database).

## Explicitly out of scope for v0.1

Broker-side storage (permanent red line), pi-mesh extension tool
registration, multi-room indexes, per-entry ACLs, urgent FAIL delivery,
GUIs, multi-machine distributed grep.

See `DESIGN.md` (once task_0002 lands) for the design and the maintainer
constraints it follows.
