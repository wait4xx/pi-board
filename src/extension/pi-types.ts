// src/extension/pi-types.ts — minimal LOCAL interfaces for the Pi
// ExtensionAPI surface (mirror of the pi-mesh extension/pi-types.ts
// pattern): ZERO imports from Pi packages — the extension is a thin
// adapter, plain JSON Schema parameters, zero-dependency.

/** JSON Schema object (plain, zero-dependency constraint). */
export type JsonSchema = Record<string, unknown>;

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  details?: Record<string, unknown>;
}

/** The subset of session events the board extension listens to. */
export type SessionEventName = "session_start" | "session_shutdown";

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
 promptSnippet?: string;
  promptGuidelines?: string;
  /** Plain JSON Schema object — NOT typebox. */
  parameters: JsonSchema;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (partial: ToolResult) => void,
    ctx: unknown,
  ) => Promise<ToolResult>;
}

/** Hand-rolled minimal surface — the real host passes a richer object. */
export interface ExtensionAPI {
  registerTool(tool: ToolDefinition): void;
  on(event: SessionEventName, handler: (event: unknown, ctx: unknown) => void | Promise<void>): void;
}

export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  const out: ToolResult = { content: [{ type: "text", text }] };
  if (details !== undefined) out.details = details;
  return out;
}
