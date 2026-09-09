// Single responsibility: a workspaceRegistry service double with N workspaces.
// Maps session ids -> workspaces exactly like the real registry's list().
import { Service } from "@deepseek-ai/cordis";

export class FakeRegistry extends Service {
  static inject = [];

  constructor(ctx, config) {
    super(ctx, "workspaceRegistry");
    const workspaces = config?.workspaces;
    this.items = (workspaces ?? [
      { id: "a", path: "C:/repo-a", sessionIds: ["sess-a"] },
      { id: "b", path: "C:/repo-b", sessionIds: ["sess-b"] },
    ]).map((w) => ({ ...w, sessionIds: [...w.sessionIds] }));
  }

  list() {
    return this.items.map((w) => ({ ...w, sessionIds: [...w.sessionIds] }));
  }
}
