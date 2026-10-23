// scripts/run-tests.mjs — portable test runner (pi-mesh / pi-jobd house style).
//
// Why: `node --test <dir>` changed behavior in newer Node versions (Node 24
// treats a directory arg as a file → MODULE_NOT_FOUND), and glob args need
// Node ≥ 21. Passing the compiled test files as EXPLICIT arguments works on
// every supported Node version and platform. Discovery is recursive to
// support nested suites.
import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
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

const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
reapOrphanTestBrokers();
process.exit(res.status ?? 1);

/** Safety net (external review, PR #2): a client connecting to a runtime dir
 *  with no listening broker AUTO-SPAWNS one (pi-mesh ensureBroker) — a leaked
 *  client or a post-teardown retry can therefore leave orphan broker
 *  processes behind, one per tmp dir. The tests themselves are hermetic
 *  (in-process brokers, noReconnect single-shot attaches); this reaps
 *  anything that still escaped, matching ONLY brokers spawned from THIS
 *  repo's node_modules copy — a real mesh broker runs a different install
 *  path and is never touched. POSIX only; visible skip on Windows. */
function reapOrphanTestBrokers() {
  const entry = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    "pi-mesh-extension",
    "dist",
    "src",
    "broker",
    "broker.js",
  );
  if (!existsSync(entry)) return; // no mesh peer installed — nothing to reap
  if (process.platform === "win32") {
    console.log("note: orphan-broker reap skipped on Windows (no pgrep/pkill)");
    return;
  }
  const listed = spawnSync("pgrep", ["-f", entry], { encoding: "utf8" });
  const pids = (listed.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== String(process.pid));
  if (pids.length === 0) return;
  spawnSync("pkill", ["-f", entry]);
  console.log(`reaped ${pids.length} orphan test broker(s) — review follow-up (leaked clients used to auto-spawn brokers via ensureBroker)`);
}
