// src/extension/session-rooms.ts — the SESSION's mesh rooms, read from the
// pi-mesh identity store. This is the fix for cross-room read pollution:
// the board's default read room must follow the SESSION (the rooms its
// mesh identity declares), not a machine-global config — an agent in room
// Z that calls board_read with no room must never be handed room M's
// entries as if they were its own context.
//
// Source of truth: the pi-mesh identity store, `$MESH_STATE_DIR ?? <cwd>/.mesh`,
// file `identity-<sessionId>.json` — the file the pi-mesh extension
// persists per session (rooms survive /reload there). Read FRESH on every
// call, no session_start snapshot: pi-mesh writes the identity
// asynchronously on client "ready", so at session_start a NEW session's
// file does not exist yet (reading it once there would silently fall back
// to the machine config — the exact bug this module exists to fix).
//
// STRICT resolution: without a sessionId the session claims NO rooms (no
// union-of-cwd guessing — a mixed-cwd union would silently bless foreign
// rooms for the read gate). Missing/corrupt identity degrades to no
// rooms. Named identity-key slots (`identity-key-<key>.json`) are
// deliberately NOT read: which key belongs to this session is pi-mesh
// internal state; a key-slot session resolves no rooms (explicit-room
// reads still work — the store-only freedom).
//
// The identity file is pi-mesh's format, read tolerantly (duck-typed
// fields, best effort): a future format change degrades to "no rooms",
// never to a crash.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** pi-mesh's identity state dir: `$MESH_STATE_DIR ?? <cwd>/.mesh`. */
function meshStateDir(env: NodeJS.ProcessEnv, cwd: string): string {
  const override = env.MESH_STATE_DIR;
  return override !== undefined && override !== "" ? override : join(cwd, ".mesh");
}

/** The rooms this session's mesh identity declares (may be []). */
export function readSessionRooms(env: NodeJS.ProcessEnv, cwd: string, sessionId: string | undefined): string[] {
  if (sessionId === undefined || sessionId === "") return [];
  const path = join(meshStateDir(env, cwd), `identity-${sessionId}.json`);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return []; // corrupt identity: degrade, never crash
  }
  if (raw === null || typeof raw !== "object") return [];
  const rooms = (raw as { rooms?: unknown }).rooms;
  if (!Array.isArray(rooms)) return [];
  return rooms.filter((r): r is string => typeof r === "string" && r !== "");
}
