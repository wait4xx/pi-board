// scripts/run-tests.mjs — portable test runner (pi-mesh / pi-jobd house style).
//
// Why: `node --test <dir>` changed behavior in newer Node versions (Node 24
// treats a directory arg as a file → MODULE_NOT_FOUND), and glob args need
// Node ≥ 21. Passing the compiled test files as EXPLICIT arguments works on
// every supported Node version and platform. Discovery is recursive to
// support nested suites.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "test",
);

function collectTestFiles(current) {
  if (!existsSync(current)) return [];
  const out = [];
  for (const entry of readdirSync(current).sort()) {
    const full = path.join(current, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (entry.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

const files = collectTestFiles(dir);
if (files.length === 0) {
  console.error(`no *.test.js files under ${dir} — run \`npm run build\` first`);
  process.exit(1);
}

// A suite that never ends (a leaked handle — a peer nobody closed, an
// un-unref'd timer) must fail LOUDLY here, not hang CI until the job
// timeout. Generous: the full suite needs well under two minutes.
const SUITE_TIMEOUT_MS = 5 * 60_000;
const res = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  timeout: SUITE_TIMEOUT_MS,
  // Spawn-proof the suite (pi-mesh ≥ 0.10.1): a client facing a missing
  // broker fails fast instead of auto-spawning one — a leaked test broker
  // must never outlive the run. Scoped to the test env only.
  env: { ...process.env, MESH_NO_AUTO_BROKER: "1" },
});
if (res.signal === "SIGTERM" && res.status === null) {
  console.error(`run-tests: SUITE TIMEOUT after ${SUITE_TIMEOUT_MS}ms — a leaked handle kept the process alive`);
}
reapOrphanTestBrokers();
process.exit(res.status ?? 1);

/** Kill brokers left behind by a crashed/timeout test. Scope: ONLY the
 *  suite's own mkdtemp dirs (pi-board-*) — the user's live mesh runtime
 *  (the default mesh-<uid> dir) is never touched. */
function reapOrphanTestBrokers() {
  const tmp = tmpdir();
  let entries;
  try {
    entries = readdirSync(tmp).filter((d) => d.startsWith("pi-board-"));
  } catch {
    return;
  }
  for (const dir of entries) {
    const lockPath = join(tmp, dir, "run", "broker.lock");
    let pid;
    try {
      pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try {
      process.kill(pid, 0); // liveness probe
      process.kill(pid, "SIGTERM"); // Windows maps this to termination
      console.log(`run-tests: reaped orphan test broker pid=${pid} (${dir})`);
    } catch {
      // already gone — nothing to do
    }
  }
}
