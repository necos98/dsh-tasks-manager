// dsh-tasks-manager — read windowing (pure: no ctx, no DSH imports).
//
// The intake preset needs `read` but must NOT get `write`/`edit`, and
// @deepseek-ai/dsh-tool-fs registers the three as one suite with no per-tool
// switch. This module is the pure half of the plugin's own read-only `read`
// tool (lib/read-tool.js): one 1-based window, `N: text` lines, line and byte
// caps, continuation footer. The envelope and the caps mirror dsh-tool-fs so an
// intake agent reads exactly what the standard preset's read tool shows.

/** Default and maximum number of lines one `read` call returns. */
export const READ_LIMIT = 2000;
/** Characters kept per line before the line is truncated with a suffix. */
export const MAX_LINE_LENGTH = 2000;
/** Byte cap on one window's selected lines; overflow ends the window early. */
export const MAX_BYTES = 51200;

/** A positive integer, or a model-facing violation. */
function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(field + " must be a positive integer");
  }
  return value;
}

/**
 * Validate the non-schema constraints of a `read` call: a non-blank path and a
 * positive `offset`/`limit`, with `limit` never above the deployment cap.
 * @param args - the schema-validated raw tool arguments.
 * @param maxLimit - the line cap: both the default `limit` and the largest accepted.
 * @returns the camelCased input with `offset` defaulted to 1 and `limit` to `maxLimit`.
 */
export function parseReadArgs(args, maxLimit) {
  if (typeof args.file_path !== "string" || args.file_path.trim().length === 0) {
    throw new Error("file_path must be a non-empty string");
  }
  const offset = args.offset === undefined ? 1 : positiveInteger(args.offset, "offset");
  const limit = args.limit === undefined ? maxLimit : positiveInteger(args.limit, "limit");
  if (limit > maxLimit) throw new Error("limit must be less than or equal to " + maxLimit);
  return { filePath: args.file_path, offset, limit };
}

/** Truncate one over-long line the way the canonical read tool does. */
function truncateLine(line, maxLineLength) {
  return line.length > maxLineLength
    ? line.substring(0, maxLineLength) + "... (line truncated to " + maxLineLength + " chars)"
    : line;
}

/**
 * Build one window from whole-file text, enforcing the line and byte caps while
 * still scanning the whole text for an exact total line count. A trailing
 * newline ends the last line rather than opening an empty one; `\r` is stripped
 * so a CRLF checkout reads as the LF file it is.
 * @param text - the decoded file text.
 * @param request - `{ offset, limit, maxLineLength?, maxBytes? }`, already defaulted by the caller.
 * @param displayPath - the caller-facing path, used in the out-of-range error.
 * @returns the numbered window lines, the total line count, and the byte-cap truncation flag.
 * @throws when `offset` is past EOF (an empty file still accepts offset 1).
 */
export function windowOf(text, request, displayPath) {
  const maxLineLength = request.maxLineLength === undefined ? MAX_LINE_LENGTH : request.maxLineLength;
  const maxBytes = request.maxBytes === undefined ? MAX_BYTES : request.maxBytes;
  const lines = [];
  let totalLines = 0;
  let outputBytes = 0;
  let truncatedByBytes = false;
  const parts = String(text).split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  for (const raw of parts) {
    totalLines += 1;
    if (truncatedByBytes || totalLines < request.offset || lines.length >= request.limit) continue;
    const line = truncateLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw, maxLineLength);
    const size = Buffer.byteLength(line, "utf8") + (lines.length > 0 ? 1 : 0);
    if (outputBytes + size > maxBytes) {
      truncatedByBytes = true;
      continue;
    }
    outputBytes += size;
    lines.push({ number: totalLines, text: line });
  }
  if (!truncatedByBytes && request.offset > totalLines && !(totalLines === 0 && request.offset === 1)) {
    throw new Error('offset ' + request.offset + ' is out of range for "' + displayPath + '" (' + totalLines + " lines)");
  }
  return { lines, totalLines, truncatedByBytes };
}

/**
 * Format one window as the model-facing JSON-compatible string the `read` tool
 * returns: numbered lines under a `<path>`/`<content>` envelope, closed by a
 * continuation or end-of-file footer.
 * @param displayPath - the backend-resolved path rendered in the envelope.
 * @param outcome - `{ offset, lines, totalLines, truncatedByBytes }`.
 * @returns the rendered envelope, ready for the tool result's text block.
 */
export function formatReadOutput(displayPath, outcome) {
  const last = outcome.lines.length > 0 ? outcome.lines[outcome.lines.length - 1].number : undefined;
  const endLine = last === undefined ? Math.max(0, outcome.offset - 1) : last;
  let footer;
  if (outcome.truncatedByBytes) {
    footer = "(Output capped. Showing lines " + outcome.offset + "-" + endLine + ". Use offset=" + (endLine + 1) + " to continue.)";
  } else if (endLine < outcome.totalLines) {
    footer = "(Showing lines " + outcome.offset + "-" + endLine + " of " + outcome.totalLines + ". Use offset=" + (endLine + 1) + " to continue.)";
  } else {
    footer = "(End of file - total " + outcome.totalLines + " lines)";
  }
  const body = outcome.lines.length > 0
    ? outcome.lines.map((line) => line.number + ": " + line.text).join("\n") + "\n\n" + footer
    : footer;
  return "<path>" + displayPath + "</path>\n<type>file</type>\n<content>\n" + body + "\n</content>";
}
