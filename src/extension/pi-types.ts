// src/extension/pi-types.ts — the local Pi ExtensionAPI mirror (the
// pi-mesh pattern): the extension layer must not import the host package,
// so the tiny surface it needs is mirrored here. Kept in lockstep with
// pi-mesh-extension's src/extension/pi-types.ts shape.
export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  details?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string;
  parameters?: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: unknown,
  ) => Promise<ToolResult> | ToolResult;
}

/** What the host passes at session_start (duck-typed, tolerant). The
 *  REAL host contract (pi 1.4.x ExtensionContext) carries `cwd` and
 *  `sessionManager: { getSessionId() }` — pi-mesh's extension reads the
 *  session id exactly there; `sessionId` is kept only as a fallback
 *  shape for hosts/tests that pass it directly. */
export interface SessionStartCtx {
  cwd?: string;
  sessionId?: string;
  sessionManager?: { getSessionId?(): string };
}

/** Resolve the session id from any host shape — sessionManager first
 *  (the verified production contract), direct field second. */
export function sessionStartId(ctx: SessionStartCtx | undefined): string | undefined {
  const viaManager = ctx?.sessionManager?.getSessionId?.();
  if (viaManager !== undefined && viaManager !== "") return viaManager;
  return ctx?.sessionId;
}

export interface ExtensionAPI {
  registerTool(def: ToolDefinition): void;
  on(event: "session_start", fn: (event: unknown, ctx?: SessionStartCtx) => void): void;
  on(event: "session_shutdown", fn: () => void): void;
}

export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  const out: ToolResult = { content: [{ type: "text", text }] };
  if (details !== undefined) out.details = details;
  return out;
}
