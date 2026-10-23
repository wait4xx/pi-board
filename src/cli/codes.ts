// cli/codes.ts — the CLI exit-code contract (DESIGN §6). Stable, documented
// in the README and asserted by tests: scripts must be able to branch on
// honest outcomes without parsing stdout. Mirrors the pi-mesh
// cli/codes.ts pattern (D5) with pi-board's own contract:
//
//   0 success (a grep miss is a success: exit 0, empty output)
//   1 error (store failure, forbidden key, board full, unreadable file)
//   2 usage error (bad args — stderr carries the usage line)
//   3 not_found (`read --id` with an unknown id)
//   4 refused (observer / non-member write attempt — gate refusal)
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_REFUSED = 4;
