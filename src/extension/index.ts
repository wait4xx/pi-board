// src/extension/index.ts — Pi extension entrypoint (the `"pi"` manifest
// points here via the root extension.ts). Thin adapter, mirror of the
// pi-mesh extension/index.ts lifecycle: tools register IMMEDIATELY (they
// answer in store-only mode when nothing is joined); session_start builds
// the runtime and AUTO-JOINS the board room when one is resolvable —
// that auto-join is the whole point: pi-mesh installed + one
// `piboard join <room>` = every session gets the board natively, no
// skill, no manual step. session_shutdown closes the peer.
import type { ExtensionAPI } from "./pi-types.js";
import { registerTools, type GetRuntime } from "./tools.js";
import { buildBoardRuntime, type BoardRuntime } from "./runtime.js";

export default function boardExtension(pi: ExtensionAPI): void {
  let runtime: BoardRuntime | null = null;
  const getRuntime: GetRuntime = () => runtime;

  // Tools answer `store-only` before session_start — never blocked.
  registerTools(pi, getRuntime);

  pi.on("session_start", () => {
    // fire-and-forget: a down broker never breaks session start
    void buildBoardRuntime()
      .then((built) => {
        runtime = built;
      })
      .catch(() => {
        runtime = null; // honest degraded mode: tools with explicit rooms still work
      });
  });

  pi.on("session_shutdown", () => {
    const current = runtime;
    runtime = null;
    void current?.close().catch(() => {});
  });
}
