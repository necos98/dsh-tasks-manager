import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
for (const f of readdirSync(path.join(root, "lib"))) { if (f.endsWith(".js")) files.push(path.join(root, "lib", f)); }
let failed = 0;
for (const file of files) { const res = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" }); if (res.status !== 0) failed++; }
console.log("checked " + files.length + " file(s), " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
