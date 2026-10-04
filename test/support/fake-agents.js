// Single responsibility: an `agents` service double for the worker spawn.
// The spawn's only requirement is create(args) returning a live handle whose
// agent carries a session (bound + titled) and followup (the first prompt).
// Every create() is recorded, so a test can assert WHICH preset the spawn
// mounted: args.meta.agentPreset is exactly what the real composeAgent honors
// and what the session header ends up carrying.
import { Service } from "@deepseek-ai/cordis";

export class FakeAgents extends Service {
  static inject = [];

  constructor(ctx) {
    super(ctx, "agents");
    /** Every create() the plugin made, in order. */
    this.created = [];
    /** The identified first prompt of each create(), in order. */
    this.prompts = [];
  }

  async create(args) {
    this.created.push(args);
    return {
      agent: {
        session: {
          id: args.sessionId,
          header: { id: args.sessionId, agentPreset: args.meta?.agentPreset },
          append: () => Promise.resolve(),
        },
        followup: (msg) => { this.prompts.push(msg); },
      },
    };
  }

  /** The preset the last created session mounts (bare id or roster id). */
  lastPreset() {
    const last = this.created[this.created.length - 1];
    return last?.meta?.agentPreset;
  }
}