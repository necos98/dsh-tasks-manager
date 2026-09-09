// Single responsibility: in-memory SettingsProvider backend for tests.
// Production uses dsh-settings-file; here load() resolves an empty document
// so namespace registration + resolve paths run for real.
import SettingsProvider from "@deepseek-ai/dsh-settings";

export class MemorySettings extends SettingsProvider {
  async load() {
    return {};
  }
}
