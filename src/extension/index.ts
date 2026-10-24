// src/extension/index.ts — Pi extension entrypoint (the `"pi"` manifest
// points here via the root extension.ts). Thin adapter, mirror of the
// pi-mesh extension lifecycle: tools register IMMEDIATELY (they answer
// in store-only mode when nothing is joined); session_start builds the
// runtime and AUTO-JOINS the board room when one is resolvable —
// observer by default (v0.2 ruling), member only via an explicit
// `piboard join`. session_shutdown closes the peer.
import type { ExtensionAPI } from "./pi-types.js";
import { registerTools, type GetRuntime } from "./tools.js";
import { buildBoardRuntime, type BoardRuntime } from "./runtime.js";

/** Optional injection for tests / hosts with a pre-built runtime.
 *  Production (the pi manifest) calls the default export with no options. */
export interface BoardExtensionOptions {
  runtime?: (env: NodeJS.ProcessEnv) => BoardRuntime;
}

export default function boardExtension(pi: ExtensionAPI, opts: BoardExtensionOptions = {}): void {
  let runtime: BoardRuntime | null = null;
  const getRuntime: GetRuntime = () => runtime;

  // Tools answer `store-only` before session_start — never blocked.
  registerTools(pi, getRuntime);

  pi.on("session_start", () => {
    // SYNCHRONOUS store-only build: tools are usable the instant this
    // fires — reads/greps never wait on the peer (availability contract,
    // runtime.ts). The peer attaches in the background; a down broker
    // never blocks session start.
    try {
      runtime = (opts.runtime ?? buildBoardRuntime)(process.env);
    } catch {
      runtime = null; // honest degraded mode: tools with explicit rooms still work
    }
  });

  pi.on("session_shutdown", () => {
    const current = runtime;
    runtime = null;
    void current?.close().catch(() => {});
  });
}
