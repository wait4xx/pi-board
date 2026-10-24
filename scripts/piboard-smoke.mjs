#!/usr/bin/env node
// scripts/piboard-smoke.mjs — task_0009 (DESIGN §7).
//
// Full chain on a TRUE broker with two fake peers:
//   join → write → broadcast → read → grep → observer refused
//
// The cli() adapter targets the REAL CLI surface (positional room,
// --observer/--alias flags, PI_BOARD_STATE_DIR env, join as a long-running
// presence daemon — see src/cli/main.ts). Broker addressing rides
// pi-mesh's own MESH_RUNTIME_DIR so the smoke never touches a live mesh.
//
// Honest-skip discipline (the T11/T13 lesson): a skipped step prints
// [skip] + reason, never a silent early-return; a failed assertion is
// [FAIL] + non-zero exit. Steps that can run without the CLI (broker,
// watcher peer) run for real regardless.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOM = "smoke";
const steps = [];
let failed = false;

function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((note) => {
      steps.push({ name, ok: true, note });
      console.log(`[ok] ${name}${note ? ` — ${note}` : ""}`);
    })
    .catch((err) => {
      if (err && err.skip === true) {
        steps.push({ name, ok: null, note: err.reason });
        console.log(`[skip] ${name} — ${err.reason}`);
        return;
      }
      failed = true;
      steps.push({ name, ok: false, note: String(err && err.message ? err.message : err) });
      console.log(`[FAIL] ${name} — ${err && err.message ? err.message : err}`);
    });
}

function skip(reason) {
  const e = new Error(reason);
  e.skip = true;
  e.reason = reason;
  return e;
}

// ---- CLI adapter (aligned to the real surface; single seam) ----
const CLI_ENTRY = path.resolve("dist/src/cli.js");
const cliAvailable = existsSync(CLI_ENTRY);

function cli(args, env, timeoutMs = 20_000) {
  if (!cliAvailable) throw skip(`piboard CLI not built yet — ${CLI_ENTRY} missing`);
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: timeoutMs,
  });
  return { code: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** join is a PRESENCE DAEMON (it owns the peer connection): spawn it
 *  detached, wait for the "joined" line, return the child handle. */
function joinDaemon({ room, alias, observer, env }) {
  if (!cliAvailable) throw skip("piboard CLI not built yet — join daemon unavailable");
  const args = ["join", room, "--alias", alias];
  if (observer) args.push("--observer");
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`join daemon never announced: ${out.slice(0, 300)}`)), 10_000);
    const poll = setInterval(() => {
      if (/^joined /m.test(out)) {
        clearTimeout(t);
        clearInterval(poll);
        resolve(child);
      }
    }, 100);
    child.once("exit", (code) => {
      clearTimeout(t);
      clearInterval(poll);
      reject(new Error(`join daemon exited early (${code}): ${out.slice(0, 300)}`));
    });
  });
  return { child, ready };
}

// ---- the scenario ----
async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "piboard-smoke-"));
  const runtimeDir = path.join(root, "run");
  const stateDir = path.join(root, "board-state");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true }); // the CLI's atomic write needs the state root to exist
  const env = {
    MESH_RUNTIME_DIR: runtimeDir, // pi-mesh's own broker-address env (MeshClient resolves it)
    PI_BOARD_STATE_DIR: stateDir, // the CLI's storage root override
  };

  let broker;
  let watcher;
  const daemons = [];

  await step("spawn a real broker (isolated runtimeDir)", async () => {
    const { createBroker } = await import("pi-mesh-extension/dist/src/broker/broker.js");
    const { DEFAULT_CONFIG } = await import("pi-mesh-extension/dist/src/shared/config.js");
    const { DEFAULT_POLICY } = await import("pi-mesh-extension/dist/src/broker/policy.js");
    broker = await createBroker({
      socketPath: path.join(runtimeDir, "broker.sock"),
      config: DEFAULT_CONFIG,
      policy: DEFAULT_POLICY,
      stateDir: path.join(root, "broker-state"),
    });
    return broker.socketPath;
  });

  await step("fake peer #1 (member watcher) joins the room", async () => {
    const { MeshClient } = await import("pi-mesh-extension/dist/src/client/client.js");
    watcher = new MeshClient({ alias: "smoke-watcher", rooms: [ROOM], runtimeDir, config: {}, noReconnect: true });
    await watcher.connect();
  });

  const broadcastSeen = [];
  watcher?.on?.("inbound", (f) => {
    if (f.broadcast === true) broadcastSeen.push(f);
  });

  await step("piboard join (member presence daemon)", async () => {
    const d = joinDaemon({ room: ROOM, alias: "board", observer: false, env });
    daemons.push(d.child);
    await d.ready;
    return "joined";
  });

  await step("piboard write FAIL entry", () => {
    const r = cli(["write", "--type", "FAIL", "--text", "smoke falsified path X"], env);
    if (r.code !== 0) throw new Error(`write exited ${r.code}: ${r.out.slice(0, 200)}`);
    return "written";
  });

  await step("broadcast frame reached the watcher", async () => {
    const deadline = Date.now() + 5_000;
    while (broadcastSeen.length === 0 && Date.now() < deadline) {
      await sleep(100);
    }
    if (broadcastSeen.length === 0) throw new Error("no broadcast frame arrived within 5s");
    const body = broadcastSeen[0].body ?? "";
    if (!body.includes("FAIL")) throw new Error(`frame body lacks the type: ${body}`);
    if (!/^board\[.+\] FAIL /.test(body)) throw new Error(`frame body is not the room-tagged format: ${body}`);
    return body;
  });
  await step("piboard read shows the entry", () => {
    const r = cli(["read"], env);
    if (!/smoke falsified path X/.test(r.out)) throw new Error(`read output missed the entry: ${r.out.slice(0, 200)}`);
  });
  await step("piboard grep finds it (boolean syntax)", () => {
    const r = cli(["grep", "smoke&falsified"], env);
    if (!/smoke falsified path X/.test(r.out)) throw new Error(`grep output missed the hit: ${r.out.slice(0, 200)}`);
  });
  await step("exactly one broadcast frame for one write (no replays)", async () => {
    // one write must cost the room exactly one frame — a watermark replay
    // or announce retry would surface here as a second frame
    await sleep(2_500); // a retry/replay rides the daemon's 1s poll loop
    if (broadcastSeen.length !== 1) {
      throw new Error(
        `expected exactly 1 broadcast frame, saw ${broadcastSeen.length}: ` +
          broadcastSeen.map((f) => JSON.stringify(f.body)).join(" | "),
      );
    }
  });
  await step("observer join + write is refused with a readable reason", async () => {
    const obsEnv = { ...env, PI_BOARD_STATE_DIR: path.join(root, "obs-state") };
    mkdirSync(obsEnv.PI_BOARD_STATE_DIR, { recursive: true });
    const d = joinDaemon({ room: ROOM, alias: "smoke-obs", observer: true, env: obsEnv });
    daemons.push(d.child);
    await d.ready;
    await sleep(300); // let the observer role land at the broker
    const r = cli(["write", "--type", "FACT", "--text", "must not land"], obsEnv);
    if (r.code === 0) throw new Error("observer write exited 0 — the gate leaked");
    if (!/observer/i.test(r.out)) throw new Error(`refusal reason not readable: ${r.out.slice(0, 200)}`);
    return r.out.trim().split("\n").pop();
  });

  // teardown
  for (const c of daemons) c.kill("SIGTERM");
  await watcher?.close?.().catch?.(() => {});
  await broker?.close?.().catch?.(() => {});
  rmSync(root, { recursive: true, force: true });

  const skipped = steps.filter((s) => s.ok === null).length;
  console.log(`\nsmoke: ${steps.filter((s) => s.ok === true).length}/${steps.length} ok, ${skipped} skipped`);
  if (failed) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("[FAIL] smoke crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
