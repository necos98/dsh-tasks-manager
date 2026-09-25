// dsh-tasks-manager — the updater's machine boundary: one command, run.
//
// Everything that starts a process goes through this module, so the install
// logic above it decides nothing about how a command is spawned.
// @module dsh-tasks-manager/updater/command

import { spawnSync } from "node:child_process";

const MISSING_RE = /(is not recognized|command not found|not found as an internal|No such file or directory)/i;
const OUTPUT_TAIL_LINES = 40;

/** The message of an unknown throwable. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The last `lines` lines of a command's output, for a report that quotes it. */
export function outputTail(output, lines = OUTPUT_TAIL_LINES) {
  const all = String(output ?? "").replace(/\r\n/g, "\n").split("\n");
  return all.slice(-lines).join("\n");
}

/**
 * Run one command to completion, never throwing: the result always carries a
 * numeric status, so a timeout or a missing executable is an outcome the
 * caller reports instead of an exception it has to catch.
 * @param {string} command
 * @param {string[]} args
 * @param {object} options - spawnSync options (cwd, shell, stdio, encoding...).
 * @param {number} timeoutMs - also the message when the command times out.
 * @returns {{status:number,output:string,notFound:boolean}}
 */
export function runCapture(command, args, options, timeoutMs) {
  const result = spawnSync(command, args, options);
  const code = result.error !== null && result.error !== undefined ? result.error.code : undefined;
  const parts = [result.stdout, result.stderr].filter((s) => typeof s === "string" && s !== "");
  let output = parts.join("\n");
  if (code === "ETIMEDOUT") output = (output === "" ? "" : output + "\n") + command + " timed out after " + timeoutMs + "ms";
  else if (code === "ENOENT") output = (output === "" ? "" : output + "\n") + command + ": not found";
  else if (result.error) output = (output === "" ? "" : output + "\n") + command + ": " + messageOf(result.error);
  return {
    status: typeof result.status === "number" ? result.status : 1,
    output,
    notFound: code === "ENOENT",
  };
}

/**
 * Whether a failed run means "this executable is not there". `spawn` reports
 * ENOENT only when it starts the program itself; with `shell: true` (needed
 * for the `.cmd` shims on Windows) the shell starts fine and reports the
 * missing program as a non-zero exit with "is not recognized" /
 * "command not found" on its output. Both spellings mean the same thing.
 * @param {{notFound:boolean,output:string}} result
 * @returns {boolean}
 */
export function isMissingExecutable(result) {
  if (result.notFound === true) return true;
  return MISSING_RE.test(String(result.output ?? ""));
}

/**
 * Run one install the way the user would run it by hand: the `dsh plugin`
 * forwarder first (it resolves the profile and reconciles the bundle list),
 * `pnpm add` in the profile directory when that executable is missing.
 * @param {{profileDir:string,spec:string,profile:string,timeoutMs:number}} request
 * @returns {{status:number,method:'dsh'|'pnpm',output:string,notFound:boolean}}
 */
export function runInstall(request) {
  const options = {
    cwd: request.profileDir,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
    timeout: request.timeoutMs,
  };
  const viaCli = runCapture(
    "dsh",
    ["plugin", "--profile", request.profile, "add", request.spec],
    options,
    request.timeoutMs,
  );
  if (!isMissingExecutable(viaCli)) return { method: "dsh", ...viaCli };
  const viaPnpm = runCapture("pnpm", ["add", request.spec], options, request.timeoutMs);
  return { method: "pnpm", ...viaPnpm };
}
