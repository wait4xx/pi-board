# Draft reply to cgarrot/pi-mesh#13 (English; posted by the coordinator
# after final review + user approval — this file is the wording of record)

---

The first slice is green: **[wait4xx/pi-board](https://github.com/wait4xx/pi-board)**
(v0.1, MIT, zero runtime dependencies, `pi-mesh-extension` as an optional
peer — verified against 0.7.2 through 0.9.0 client cores).

What landed, straight down your five constraints:

- **Typed entries** — `OBSERVED / FACT / FAIL / CLAIM / PATCH_SUMMARY`,
  closed set; short summary always, long `detail` only via `read --id`
  (never on the wire).
- **Bounded, honest storage** — append-only JSONL segments with rotation,
  caps that *refuse* (never silently evict — a referenced id must not
  vanish), TTL visibility, and a fail-closed secret-shape scan. No storage
  anywhere near the broker: the mesh stays a router.
- **Boolean grep** — `,` = OR, `&` = AND, case-insensitive over summary and
  detail, across the whole TTL-visible span; a miss is an honest empty list.
  Every row carries the id; a detail-only hit is marked `(in detail)`.
- **Gates per your ruling** — the board joins as a normal peer (member or
  read-only observer), and the write gate checks membership before role,
  mirroring `routeMsg`'s order — with the reconnect-role-reassert defense
  from the ctl bug class you flagged.
- **FAIL at normal priority** — one normal broadcast frame per write; the
  watcher prints a single turn-boundary "N new FAIL" summary line. No
  urgent frames anywhere.

CLAIM stays purely informational (`--lease-ref` annotates the `mesh_claim`
lease id for correlation; the board enforces nothing).

Measured on the delivery tree (`ece67d8`, Linux, Node 22): strict build
clean, **55 tests / 0 fail**, and a **9-step smoke on a real broker**
(join → write → broadcast → read → grep → observer refused → exactly-one-
frame …). Every number in the README traces to a re-runnable command in
[docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md).

Single room, single machine in v0.1 — multi-machine search and indexes are
deliberately out. The repo carries an open collaborator invite for you
(whole-repo transfer is on the table too — your call). A design review
pass would be very welcome, especially on the storage bounds and the
gate ordering.
