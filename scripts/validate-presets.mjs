// Validate the shipped agent presets against the installed DSH plugins.
//
// A preset row is only correct for the DSH build it mounts on: the loader
// parses `agent.cordis.yml` with cordis-plugin-include's entry-list dialect and
// then validates every row's `config` against that plugin's own `Config` schema
// (the same `~standard.validate` call the loader makes). This guard runs both
// steps offline, so a renamed or changed plugin field (for example persona's
// `text` -> `prefix`) fails here instead of when the user switches preset.
//
// Skips with a notice when no DSH install is reachable (a bare checkout).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRESET_ROOT = join(root, "presets");

/** `node_modules` roots that may hold the DSH packages, in priority order. */
function moduleRoots() {
  const roots = [];
  if (process.env.DSH_NODE_MODULES) roots.push(process.env.DSH_NODE_MODULES);
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules"));
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    roots.push(join(home, ".dsh", "profiles", "node_modules"));
    roots.push(join(home, ".dsh", "profiles", "web", "node_modules"));
  }
  return roots.filter((dir) => existsSync(dir));
}

/** Directory of one package name, searched across the known module roots. */
function packageDir(name) {
  for (const dir of moduleRoots()) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The module entry a package publishes (exports "." first, then main). */
function entryFile(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const dot = pkg.exports?.["."];
  const main = typeof dot === "string" ? dot : typeof dot === "object" ? dot.default ?? dot.import : undefined;
  return join(dir, main ?? pkg.main ?? "index.js");
}

/** Resolve a row `name` to a loadable module file, or undefined for builtins. */
function resolveRow(name) {
  if (name === "cordis:group" || name.startsWith("cordis:")) return undefined;
  if (name.startsWith("@deepseek-ai/")) {
    const dir = packageDir(name);
    return dir === undefined ? { missing: true } : { file: entryFile(dir) };
  }
  if (name.startsWith("dsh-tasks-manager/")) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const rel = pkg.exports?.["./" + name.slice("dsh-tasks-manager/".length)];
    return rel === undefined ? { missing: true } : { file: join(root, rel) };
  }
  const dir = packageDir(name);
  return dir === undefined ? { missing: true } : { file: entryFile(dir) };
}

/** Rows of one parsed entry list, groups flattened depth-first. */
function* rows(entries) {
  for (const entry of entries) {
    yield entry;
    if (Array.isArray(entry.config)) yield* rows(entry.config);
  }
}

/** Validate one row's config exactly as the loader does at mount. */
async function checkRow(entry) {
  const target = resolveRow(entry.name);
  if (target === undefined) return { status: "skip", reason: "builtin group row" };
  if (target.missing) return { status: "fail", reason: "package not installed: " + entry.name };
  let mod;
  try {
    mod = await import(pathToFileURL(target.file).href);
  } catch (error) {
    return { status: "fail", reason: "cannot import: " + (error?.message ?? String(error)) };
  }
  const Config = mod.Config ?? mod.default?.Config;
  if (Config === undefined) {
    return entry.config === undefined
      ? { status: "ok" }
      : { status: "fail", reason: "row carries config but the plugin exports no Config schema" };
  }
  const result = Config["~standard"].validate(entry.config ?? {});
  if (result.issues) {
    const first = result.issues[0];
    const path = Array.isArray(first?.path) ? first.path.join(".") : "";
    return { status: "fail", reason: "invalid config: " + (first?.message ?? "unknown") + (path === "" ? "" : " (at " + path + ")") };
  }
  return { status: "ok" };
}

const includeDir = packageDir("@deepseek-ai/cordis-plugin-include");
const yamlDir = packageDir("js-yaml");
if (includeDir === undefined || yamlDir === undefined) {
  console.log("validate-presets: no DSH install found (set DSH_NODE_MODULES to its node_modules) — skipped");
  process.exit(0);
}
const includeMod = await import(pathToFileURL(entryFile(includeDir)).href);
const yamlMod = await import(pathToFileURL(entryFile(yamlDir)).href);
const yaml = yamlMod.default ?? yamlMod;

let failures = 0;
const presets = readdirSync(PRESET_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
if (presets.length === 0) {
  console.log("validate-presets: no presets found");
  process.exit(0);
}
for (const preset of presets) {
  const file = join(PRESET_ROOT, preset, "agent.cordis.yml");
  const entries = yaml.load(readFileSync(file, "utf8"), { schema: includeMod.entryListSchema });
  console.log("preset " + preset);
  for (const entry of rows(entries)) {
    const outcome = await checkRow(entry);
    const label = (entry.disabled === undefined ? "" : " [disabled]") + (entry.config === undefined || Array.isArray(entry.config) ? "" : "");
    if (outcome.status === "fail") {
      failures++;
      console.log("  FAIL " + entry.id + " (" + entry.name + ")" + label + ": " + outcome.reason);
    } else {
      console.log("  " + (outcome.status === "ok" ? "ok  " : "----") + " " + entry.id + " (" + entry.name + ")" + label);
    }
  }
}
console.log(failures === 0 ? "validate-presets: all rows valid" : "validate-presets: " + failures + " row(s) invalid");
process.exit(failures === 0 ? 0 : 1);
