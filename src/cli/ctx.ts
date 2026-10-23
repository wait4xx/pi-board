// cli/ctx.ts — shared CLI context: state-root resolution + the joined
// board config + room resolution (mirror of the pi-mesh cli/ctx.ts role:
// one place so every command honors the same flags/env/config chain —
// never a per-command reimplementation).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../store/store.js";

/** The persisted board face written by `piboard join` (DESIGN §5.1):
 *  room + role + alias. Store-only commands work without it. */
export interface BoardConfig {
  room: string;
  observer: boolean;
  alias: string;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateRoot(env), "board.json");
}

export function loadBoardConfig(env: NodeJS.ProcessEnv = process.env): BoardConfig | undefined {
  const path = configPath(env);
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BoardConfig>;
  if (typeof raw.room !== "string" || raw.room === "") {
    throw new Error(`board config unreadable (${path}): room missing`);
  }
  return {
    room: raw.room,
    observer: raw.observer === true,
    alias: typeof raw.alias === "string" && raw.alias !== "" ? raw.alias : "board",
  };
}

export function saveBoardConfig(config: BoardConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = configPath(env);
  mkdirSync(stateRoot(env), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

export type RoomResolution =
  | { ok: true; room: string; config: BoardConfig | undefined; joined: boolean }
  | { ok: false; error: string };

/**
 * Room resolution: `--room` flag > `$PI_BOARD_ROOM` > the config saved by
 * `piboard join`. `joined` is true only when the resolved room IS the
 * joined room (a --room override means a store-only write: no announce).
 */
export function resolveRoom(
  values: Map<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): RoomResolution {
  const fromFlag = values.get("room");
  if (fromFlag !== undefined && fromFlag !== "") {
    const config = loadBoardConfig(env);
    return { ok: true, room: fromFlag, config, joined: config !== undefined && config.room === fromFlag };
  }
  const fromEnv = env.PI_BOARD_ROOM;
  if (fromEnv !== undefined && fromEnv !== "") {
    const config = loadBoardConfig(env);
    return { ok: true, room: fromEnv, config, joined: config !== undefined && config.room === fromEnv };
  }
  const config = loadBoardConfig(env);
  if (config !== undefined) return { ok: true, room: config.room, config, joined: true };
  return {
    ok: false,
    error: "no room: use --room, set $PI_BOARD_ROOM, or run `piboard join <room>` first",
  };
}
