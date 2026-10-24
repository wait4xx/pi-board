# Contributing to pi-board

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

## Ground rules

- **Zero runtime dependencies.** Everything is plain Node (ESM,
  NodeNext, strict tsc); `pi-mesh-extension` is an optional peer only.
- **Layering:** `store/` never imports `mesh/` or the extension; the
  extension is a thin adapter. The CLI and the extension are two faces
  of the same entries/store core.
- **Honesty is the product:** refuse over guess, visible skips over
  silent greens, measured numbers over arithmetic. If a claim cannot be
  measured, it does not go in the docs.

## Commits

- Conventional format: `type(scope): imperative subject` — **English
  subject AND body** (the docs are bilingual; the history is not).
- One commit, one intent; the body explains WHY first, then the key
  moves (`-` bullets). `feat`/`fix`/`perf` carry a `Verified:` line with
  real commands and real numbers — nothing that was not actually run.
- No agent names, no `.spec/` paths (the spec workspace stays local),
  no trailer footers referencing out-of-repo artifacts.

## Tests

- `npm test` green before every commit; a behavior change lands WITH a
  test that can fail (assert the invariant, not the implementation).
- Real processes and a real broker for anything touching mesh/CLI —
  hermetic tmp dirs, scrubbed env, no shared state.
- Platform-conditional tests skip **visibly with a reason** — never a
  silent early-return that counts as a pass.
- CI (`.github/workflows/ci.yml`) runs the full chain on ubuntu ×
  node 20/22; a red CI blocks merge, a badge that lies is worse than
  no badge.

## Measured numbers

- Every number that appears in README/announcements traces to a
  re-runnable command, its key output, and a commit hash — recorded in
  [docs/DELIVERY-RECON.md](docs/DELIVERY-RECON.md).
- Never publish a number you did not run at the tree being described
  (the "no arithmetic" rule: 55+9 is not 64 until both were measured).

## Docs (four-file bilingual system)

- Bilingual docs are **separate complete files, not interleaved**:
  `README.md` / `README.zh-CN.md` and `CONTRIBUTING.md` /
  `CONTRIBUTING.zh-CN.md`. Each pair cross-links at the top and mirrors
  section-by-section (the CN file is a full counterpart, not a
  summary).
- **Sync rule:** any change to one file of a pair lands in the same
  commit with its counterpart updated — a PR that edits only one
  language is incomplete by definition. New sections are added to both
  or neither.
- Commit messages stay English-only (see Commits) — the bilingual rule
  governs documentation files, never the history.

## Design changes

- `DESIGN.md` is the contract; deviations land as explicit erratum
  notes in the affected section (see §3.2/§6 for the pattern), never as
  silent drift. Scope changes go through the spec package — an
  out-of-scope feature is a new package, not a quiet addition.
