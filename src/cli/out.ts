// cli/out.ts — stdout/stderr helpers (mirror of the pi-mesh cli/out.ts
// surface, scoped to v0.1: no colors, no NDJSON — piboard output lines are
// greppable plain text; a miss is an honest empty, and errors never mix
// into stdout).

export function say(line = ""): void {
  process.stdout.write(line + "\n");
}

export function sayErr(line = ""): void {
  process.stderr.write(line + "\n");
}
