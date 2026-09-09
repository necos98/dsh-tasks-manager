// Single responsibility: invoke the REAL host services the way agents do.
// callTool: resolve via tools.get() (visibility), run defineTool execute
// (arg validation), then createSuccessResult (output-schema validation +
// render) — the same pipeline a model call traverses, minus the scheduler.
// runCommand: full commands.execute() path incl. normalizeResult.

// Minimal agent shape: session id for workspace routing + append() for the
// command lifecycle log. No other agent machinery is stubbed.
export function fakeAgent(sessionId) {
  return {
    session: {
      header: { id: sessionId },
      append() {
        return Promise.resolve();
      },
    },
  };
}

export function toolNames(ctx) {
  return ctx.get("tools").schemas(undefined).map((s) => s.name).sort();
}

export async function callTool(ctx, sessionId, name, args) {
  const tools = ctx.get("tools");
  const definition = tools.get(name, undefined);
  if (!definition) throw new Error(`tool "${name}" is not visible`);
  const agent = fakeAgent(sessionId);
  const exec = { name, arguments: args ?? {}, agent, callId: `it-${name}`, signal: AbortSignal.abort ? new AbortController().signal : undefined };
  const value = await definition.execute(exec.arguments, exec);
  const result = tools.createSuccessResult(exec, definition, value);
  return { value, content: result.content };
}

export async function runCommand(ctx, sessionId, line) {
  const commands = ctx.get("commands");
  const settled = await commands.execute(fakeAgent(sessionId), line, [], AbortSignal.timeout(10000));
  return settled;
}
