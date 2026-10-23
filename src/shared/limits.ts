/**
 * src/shared/limits.ts — every bound of the board, named (house rule).
 *
 * Operators can tighten or widen any bound via `PI_BOARD_<NAME>` env vars
 * (TTL bounds the searchable span; 7 d is tight for long task lines).
 * Parsing is fail-closed: an unusable value is an error naming the
 * variable, never a silent fallback to the default.
 */

/** Default state root: `$PI_BOARD_STATE_DIR` or `~/.pi-board`. */
export const STATE_DIR_NAME = ".pi-board";

export const SEGMENT_MAX_ENTRIES = 10_000;
export const SEGMENT_MAX_BYTES = 1_048_576; // 1 MiB
export const MAX_ENTRIES = 50_000;
export const MAX_TOTAL_BYTES = 33_554_432; // 32 MiB
export const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 d
export const MAX_TEXT_CHARS = 280;
export const MAX_DETAIL_CHARS = 8_192;
export const READ_WINDOW_DEFAULT = 2_000;
export const READ_WINDOW_MAX = 10_000;

/**
 * Secret shapes that must never be persisted. The pi-mesh ledger pattern
 * class: a match refuses the append (fail-closed), and the error names the
 * pattern, never the matched text.
 */
export const FORBIDDEN_KEY_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{16,}/, // GitHub token (classic + fine-grained)
  /sk-[A-Za-z0-9-]{20,}/, // generic API secret (OpenAI-style, incl. sk-proj-)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key block
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack token
];

export interface Limits {
  segmentMaxEntries: number;
  segmentMaxBytes: number;
  maxEntries: number;
  maxTotalBytes: number;
  entryTtlMs: number;
  maxTextChars: number;
  maxDetailChars: number;
  readWindowDefault: number;
  readWindowMax: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`limit_override_invalid: ${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

/** Defaults + env overrides, cross-validated. Pure: takes env, returns limits. */
export function loadLimits(env: NodeJS.ProcessEnv = process.env): Limits {
  const limits: Limits = {
    segmentMaxEntries: positiveInt(env, "PI_BOARD_SEGMENT_MAX_ENTRIES", SEGMENT_MAX_ENTRIES),
    segmentMaxBytes: positiveInt(env, "PI_BOARD_SEGMENT_MAX_BYTES", SEGMENT_MAX_BYTES),
    maxEntries: positiveInt(env, "PI_BOARD_MAX_ENTRIES", MAX_ENTRIES),
    maxTotalBytes: positiveInt(env, "PI_BOARD_MAX_TOTAL_BYTES", MAX_TOTAL_BYTES),
    entryTtlMs: positiveInt(env, "PI_BOARD_ENTRY_TTL_MS", ENTRY_TTL_MS),
    maxTextChars: positiveInt(env, "PI_BOARD_MAX_TEXT_CHARS", MAX_TEXT_CHARS),
    maxDetailChars: positiveInt(env, "PI_BOARD_MAX_DETAIL_CHARS", MAX_DETAIL_CHARS),
    readWindowDefault: positiveInt(env, "PI_BOARD_READ_WINDOW_DEFAULT", READ_WINDOW_DEFAULT),
    readWindowMax: positiveInt(env, "PI_BOARD_READ_WINDOW_MAX", READ_WINDOW_MAX),
  };
  if (limits.readWindowDefault > limits.readWindowMax) {
    throw new Error(
      `limit_override_invalid: PI_BOARD_READ_WINDOW_DEFAULT (${limits.readWindowDefault}) must not exceed PI_BOARD_READ_WINDOW_MAX (${limits.readWindowMax})`,
    );
  }
  return limits;
}
