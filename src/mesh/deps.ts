// src/mesh/deps.ts — the single import site for the pi-mesh-extension peer.
//
// Why a deep path and never the package index: the index exports the Pi
// EXTENSION (runtime peer deps @opencode-ai/plugin + pi-tui), while the
// broker/client/protocol layers are Pi-free by upstream's own layering
// rule. A board (CLI, no Pi host) must not transitively drag the Pi
// extension stack. The `./*` export entry makes this resolvable.
//
// Dependency face (spike 2026-10-23, probe: join member/observer, observer
// read-only + room-member broker gates, broadcast, reconnect — 7/7 on
// every version tested): 0.7.2 / 0.7.5 / 0.7.6 / 0.7.7 / 0.8.0 / 0.9.0.
// The board needs the CLIENT CORE only; the ctl control plane (0.9.0) is
// NOT required. package.json therefore declares peerDependencies "*"
// (installed where a mesh already runs) with >=0.7.2 as the verified
// floor — see spec.md §2.3.
//
// The peer is declared OPTIONAL: store-only commands work without it.
// Mesh commands fail with this honest error instead of a module-not-found
// stack when the operator never installed a mesh.

/** Thrown/returned when pi-mesh-extension is absent: the actionable message
 *  for CLI mesh subcommands (install hint, not a crash). */
export const PEER_MISSING_MESSAGE =
  "pi-mesh-extension is required for mesh commands — install it alongside pi-board (npm i pi-mesh-extension)";

export type MeshModule = typeof import("pi-mesh-extension/dist/src/client/client.js");

let cached: MeshModule | undefined;

/** Load the client core. Rejects with PEER_MISSING_MESSAGE converted to an
 *  Error when the optional peer is not installed. */
export async function loadMesh(): Promise<MeshModule> {
  if (cached !== undefined) return cached;
  try {
    cached = (await import("pi-mesh-extension/dist/src/client/client.js")) as MeshModule;
  } catch {
    throw new Error(PEER_MISSING_MESSAGE);
  }
  return cached;
}
