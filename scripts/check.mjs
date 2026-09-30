import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
for (const f of readdirSync(path.join(root, "lib"))) { if (f.endsWith(".js")) files.push(path.join(root, "lib", f)); }
let failed = 0;
for (const file of files) { const res = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" }); if (res.status !== 0) failed++; }
console.log("checked " + files.length + " file(s), " + failed + " failed");

// THE DSH LINE. DSH gates a plugin on the `@deepseek-ai/dsh*` peers it declares:
// `evaluatePluginCompatibility` (@deepseek-ai/dsh-app-boot) compares every such
// range against the version of the RUNNING runtime, and refuses the install (or
// denies the mounted bundle at boot) when a range does not cover it. Version
// 0.4.0 pinned 0.1.7-rc.2 on dsh-system-prompt and dsh-tools and was refused on
// DSH 0.2.0-rc.2 for exactly that reason — a stale pin is a refusal, not a
// warning. So: every DSH peer is ONE EXACT version, equal to the version really
// installed here, and the whole installed line must agree with itself (DSH ships
// every @deepseek-ai/dsh* package at the runtime version).
const DSH_PACKAGE = /^@deepseek-ai\/dsh(?:-.*)?$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const installedVersion = (name) => {
  const file = path.join(root, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(file)) return undefined;
  try { const version = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")).version; return typeof version === "string" ? version : undefined; } catch { return undefined; }
};
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8").replace(/^\uFEFF/, ""));
const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => DSH_PACKAGE.test(name));
if (peers.length === 0) { console.log("dsh line: package.json declares no @deepseek-ai/dsh* peer"); failed++; }
for (const [name, range] of peers) {
  if (typeof range !== "string" || !EXACT_VERSION.test(range)) { console.log("dsh line: " + name + " must pin one exact version, found " + JSON.stringify(range)); failed++; continue; }
  const installed = installedVersion(name);
  if (installed === undefined) { console.log("dsh line: " + name + "@" + range + " is not installed in node_modules — run pnpm install"); failed++; }
  else if (installed !== range) { console.log("dsh line: " + name + " pins " + range + " but node_modules has " + installed); failed++; }
}
const line = new Set(peers.map(([name]) => installedVersion(name)).filter((version) => version !== undefined));
if (line.size > 1) { console.log("dsh line: the installed @deepseek-ai/dsh* packages disagree (" + [...line].sort().join(", ") + ")"); failed++; }
if (line.size === 1) console.log("dsh line: " + [...line][0] + " (" + peers.length + " peer pin(s))");

process.exit(failed > 0 ? 1 : 0);
