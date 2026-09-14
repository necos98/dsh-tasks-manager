// Single responsibility: an `fs` service double backed by an in-memory map.
// Implements only the FileSystem members the read-only tool uses (resolve,
// stat, readText); anything a write path would need is deliberately absent, so
// a test that accidentally reached one fails loudly instead of passing.
import { Service } from "@deepseek-ai/cordis";

export class FakeFs extends Service {
  static inject = [];

  /** @param config.files - map of displayPath -> { text } | { dir: true } */
  constructor(ctx, config) {
    super(ctx, "fs");
    this.files = new Map(Object.entries(config?.files ?? {}));
  }

  async resolve(path) {
    return { targetKey: "k:" + path, displayPath: path };
  }

  async stat(target) {
    const entry = this.files.get(target.displayPath);
    if (!entry) return undefined;
    if (entry.dir) return { version: "v1", type: "directory" };
    return { version: "v1", type: "file", size: Buffer.byteLength(entry.text, "utf8") };
  }

  async readText(target) {
    const entry = this.files.get(target.displayPath);
    if (!entry || entry.dir) throw new Error("not a regular file");
    return entry.text;
  }
}
