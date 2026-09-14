// dsh-tasks-manager/read-tool — scoped plugin entry: a READ-ONLY `read` tool.
//
// Why this exists: the intake agent must inspect the repo deeply, but
// @deepseek-ai/dsh-tool-fs registers read/write/edit as ONE suite with no
// per-tool switch, so mounting it would hand triage write+edit and revoke the
// design's physical "no write tools" guarantee (design-tasks-simple.md S3/S12).
// `tools.restrict()` cannot help either: a restriction only masks tools a scope
// INHERITS, never the ones its own preset registered. So the plugin registers
// exactly one tool over the host `fs` service: `read`, nothing that mutates.
// A preset must mount EITHER this entry OR dsh-tool-fs — both register the name
// `read`, and a duplicate name in one scope throws.
// @module dsh-tasks-manager-read-tool
import { defineTool } from "@deepseek-ai/dsh-tools";
import { READ_LIMIT, formatReadOutput, parseReadArgs, windowOf } from "./read-window.js";

export const name = "dsh-tasks-manager-read-tool";
export const inject = ["tools", "fs", "systemPrompt"];

/** The calling agent's session workspace, or undefined for a non-agent caller. */
function sessionCwd(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
      ? exec.agent.session.header.cwd
      : undefined;
    return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
  } catch {
    return undefined;
  }
}

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: "tool:read",
    order: ctx.systemPrompt.getSectionOrder("TOOL_READ"),
    text: "Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.",
  });

  ctx.tools.register(defineTool({
    name: "read",
    description: "Read a UTF-8 text file and return line-numbered content. Read-only: this agent has no write or edit tool.",
    parameters: {
      file_path: {
        type: "string",
        required: true,
        description: "Path to read, resolved by the filesystem backend.",
      },
      offset: {
        type: "number",
        description: "1-based first line to return. Defaults to 1.",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to return. Defaults to " + READ_LIMIT + ".",
      },
    },
    output: {
      schema: { type: "string" },
      render(_args, value) {
        return [{ type: "text", text: value }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args, READ_LIMIT);
      const cwd = sessionCwd(exec);
      const target = await ctx.fs.resolve(input.filePath, {
        ...(cwd === undefined ? {} : { cwd }),
        signal: exec.signal,
      });
      const info = await ctx.fs.stat(target, exec.signal);
      if (info === undefined) throw new Error('cannot read "' + target.displayPath + '": not found');
      if (info.type !== "file") throw new Error('cannot read "' + target.displayPath + '": not a regular file');
      const text = await ctx.fs.readText(target, exec.signal);
      const window = windowOf(text, { offset: input.offset, limit: input.limit }, target.displayPath);
      // Same observation contract as the canonical read tool, so the host's
      // fs-observation-policy records this read identically.
      ctx.emit("fs/observed", target, { kind: "present", version: info.version }, exec);
      return formatReadOutput(target.displayPath, {
        offset: input.offset,
        lines: window.lines,
        totalLines: window.totalLines,
        truncatedByBytes: window.truncatedByBytes,
      });
    },
  }));
}
