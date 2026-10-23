// extension.ts — Pi package entry (the "pi" manifest in package.json
// points here). The extension implementation lives in src/extension/
// (compiled adapter, zero Pi imports — the local pi-types.ts mirrors the
// ExtensionAPI surface, the pi-mesh pattern).
export { default } from "./src/extension/index.js";
