// In-memory holder for the user settings loaded from (and saved back to) the
// JSON file the main process owns. The folder tree and the new-tab command menu
// read `commands()` live whenever they open, so a save is immediately reflected
// without any change-notification plumbing.
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CommandPreset,
  type GeneralSettings,
} from '../electron/ipc';

export class SettingsStore {
  private settings: AppSettings = DEFAULT_SETTINGS;

  /** Load the persisted settings from the main process. Call once at startup. */
  async load(): Promise<void> {
    try {
      this.settings = await window.api.settings.get();
    } catch {
      this.settings = DEFAULT_SETTINGS;
    }
  }

  get(): AppSettings {
    return this.settings;
  }

  commands(): CommandPreset[] {
    return this.settings.commands;
  }

  general(): GeneralSettings {
    return this.settings.general;
  }

  pinned(): string[] {
    return this.settings.pinnedFolders;
  }

  /** Replace and persist just the pinned-folder list (other settings untouched). */
  async setPinned(folders: string[]): Promise<void> {
    this.settings = { ...this.settings, pinnedFolders: folders };
    await window.api.settings.save(this.settings);
  }

  /** Replace and persist the full settings object. */
  async save(next: AppSettings): Promise<void> {
    this.settings = next;
    await window.api.settings.save(next);
  }
}
