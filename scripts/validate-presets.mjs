// Validate the shipped agent presets against the installed DSH plugins.
//
// A preset is only correct for the DSH build it mounts on. Since DSH
// 0.1.7-rc.2 a preset is NOT a directory under $DSH_HOME/.agent-presets (that
// root is read by nothing any more): it is an `@deepseek-ai/dsh-agent-preset`
// DECLARATION carried by a bundle patch. So this guard walks the patch files
// this package lists in its own `dsh.bundle.patch`, parses each one the way the
// loader does (cordis-plugin-include's entry-list dialect) and then validates
// every row's `config` against that plugin's own `Config` schema (the same
// `~standard.validate` call the loader makes at mount). A preset declaration is
// descended into, so `config.plugins` is checked row by row: a renamed or
// changed plugin field (for example persona's `text` -> `prefix`) fails here
// instead of when the user switches preset.
//
// Skips with a notice when no DSH install is reachable (a bare checkout).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** One path relative to the package root, always with forward slashes. */
function rel(file) {
  return file.slice(root.length + 1).split(sep).join("/");
}

/** The bundle patch files this package ships, in composition order. */
function patchFiles() {
  const patch = pkg.dsh?.bundle?.patch;
  const list = Array.isArray(patch) ? patch : patch === undefined ? [] : [patch];
  return list.map((rel) => join(root, rel));
}

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

/** Every row a parsed bundle patch carries: inserts, then id-targeted overrides. */
function* patchRows(entries) {
  for (const entry of entries) {
    if (Array.isArray(entry?.insert)) yield* rows(entry.insert);
    else if (entry?.name !== undefined) yield entry;
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
  // A preset DECLARATION nests its whole entry list: check every child row.
  if (entry.name === "@deepseek-ai/dsh-agent-preset" && Array.isArray(entry.config?.plugins)) {
    return { status: "ok", children: [...rows(entry.config.plugins)] };
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
let checked = 0;
const files = patchFiles();
if (files.length === 0) {
  console.log("validate-presets: the package declares no bundle patch");
  process.exit(0);
}
for (const file of files) {
  if (!existsSync(file)) {
    failures++;
    console.log("patch " + rel(file) + ": MISSING");
    continue;
  }
  console.log("patch " + rel(file));
  const entries = yaml.load(readFileSync(file, "utf8"), { schema: includeMod.entryListSchema });
  for (const entry of patchRows(entries)) {
    const outcome = await checkRow(entry);
    const label = entry.disabled === undefined ? "" : " [disabled]";
    if (outcome.status === "fail") {
      failures++;
      console.log("  FAIL " + entry.id + " (" + entry.name + ")" + label + ": " + outcome.reason);
      continue;
    }
    checked++;
    console.log("  " + (outcome.status === "ok" ? "ok  " : "----") + " " + entry.id + " (" + entry.name + ")" + label);
    for (const child of outcome.children ?? []) {
      const childOutcome = await checkRow(child);
      const childLabel = child.disabled === undefined ? "" : " [disabled]";
      if (childOutcome.status === "fail") {
        failures++;
        console.log("  FAIL " + child.id + " (" + child.name + ")" + childLabel + ": " + childOutcome.reason);
      } else {
        checked++;
        console.log("    " + (childOutcome.status === "ok" ? "ok  " : "----") + " " + child.id + " (" + child.name + ")" + childLabel);
      }
    }
  }
}
console.log(failures === 0 ? "validate-presets: " + checked + " row(s) valid" : "validate-presets: " + failures + " row(s) invalid");
process.exit(failures === 0 ? 0 : 1);
