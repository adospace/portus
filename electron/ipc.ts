// Shared IPC contract between the Electron main process, the preload bridge,
// and the renderer. Keeping the channel names and payload shapes in one place
// avoids drift between the three layers.

export type SessionStatus = 'busy' | 'idle' | 'done';

export interface PersistedSession {
  id: string;
  folder: string;
  claudeId: string | null;
  /** Short summary title emitted by the agent CLI via the terminal title (OSC),
   *  e.g. Claude Code's task summary. Null until one is seen; falls back to the
   *  folder name in the UI. */
  title: string | null;
  createdAt: string;
  lastActive: string;
  totalTokens: number;
  totalCost: number;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** A mountable filesystem root: a Windows drive letter or a macOS volume. */
export interface Drive {
  /** Display label, e.g. "C:" on Windows or "Macintosh HD" on macOS. */
  label: string;
  /** Absolute path to the root, e.g. "C:\\" or "/" or "/Volumes/USB". */
  path: string;
}

export interface SpawnRequest {
  folder: string;
  cols: number;
  rows: number;
  /** Command typed into the shell on launch. Defaults to `claude`. */
  startupCommand?: string;
}

export interface UsageEvent {
  ptyId: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * How full a live session's context window is, read from its Claude Code
 * transcript. `tokens` is the prompt size of the most recent turn (input +
 * cache-creation + cache-read), which approximates current context occupancy;
 * `limit` is the model's context window. Drives the per-tab "heaviness" gauge.
 */
export interface ContextUsage {
  tokens: number;
  limit: number;
  model: string;
}

/**
 * One user-defined launch command, shown in the "+" new-tab menu and the folder
 * tree's right-click menu. `command` is typed into the freshly spawned shell; an
 * empty string means "just a plain shell" (no startup command).
 */
export interface CommandPreset {
  name: string;
  command: string;
}

/** Theme preference: follow the OS, or force light/dark. */
export type ThemeChoice = 'system' | 'light' | 'dark';

/**
 * General application preferences (the "General" settings section).
 * `defaultFolder` is where the pane "+" button opens a new session ('' → the
 * user's home folder); `sessionRetentionDays` is how long history rows are kept
 * before they're pruned on startup; `theme` selects the color scheme.
 */
export interface GeneralSettings {
  defaultFolder: string;
  sessionRetentionDays: number;
  theme: ThemeChoice;
}

/** User-editable application settings, persisted as JSON in the user data dir. */
export interface AppSettings {
  commands: CommandPreset[];
  general: GeneralSettings;
}

export const DEFAULT_GENERAL: GeneralSettings = {
  defaultFolder: '',
  sessionRetentionDays: 30,
  theme: 'system',
};

/**
 * Seed commands shipped on first run (no settings file yet). Covers the common
 * agent CLIs plus a couple of build commands as examples the user can edit.
 */
export const DEFAULT_COMMANDS: CommandPreset[] = [
  { name: 'Claude', command: 'claude' },
  { name: 'Claude (continue)', command: 'claude --continue' },
  { name: 'Claude (skip permissions)', command: 'claude --dangerously-skip-permissions' },
  { name: 'Codex', command: 'codex' },
  { name: 'Shell', command: '' },
  { name: 'npm build', command: 'npm run build' },
  { name: 'dotnet build', command: 'dotnet build' },
  { name: 'dotnet run', command: 'dotnet run' },
];

export const DEFAULT_SETTINGS: AppSettings = {
  commands: DEFAULT_COMMANDS,
  general: DEFAULT_GENERAL,
};

/**
 * Whether a terminal title is worth showing as a session label. Shells (notably
 * PowerShell / conhost on Windows) set the OSC title to the executable's full
 * path, e.g. "C:\\…\\powershell.exe", or to the bare working directory — neither
 * is a useful name. A title counts as meaningful only if it doesn't look like an
 * executable or a bare filesystem path; otherwise callers fall back to the
 * folder name.
 */
export function isMeaningfulTitle(title: string | null | undefined): boolean {
  const t = title?.trim();
  if (!t) return false;
  if (/\.exe$/i.test(t)) return false; // "…\powershell.exe", "cmd.exe", …
  // A spaceless absolute path (Windows drive or POSIX root) is a shell cwd/exe
  // title, not an agent's task summary (which reads as prose, with spaces).
  if (!t.includes(' ') && /^([a-zA-Z]:[\\/]|[\\/])/.test(t)) return false;
  return true;
}

export const Channels = {
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data',
  ptyStatus: 'pty:status',
  ptyUsage: 'pty:usage',
  ptyExit: 'pty:exit',
  fsListDir: 'fs:listDir',
  fsHome: 'fs:home',
  fsDrives: 'fs:drives',
  fsPickFolder: 'fs:pickFolder',
  shellOpenPath: 'shell:openPath',
  contextGet: 'context:get',
  sessionList: 'session:list',
  sessionSave: 'session:save',
  sessionGet: 'session:get',
  sessionDelete: 'session:delete',
  usageAdd: 'usage:add',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  winMinimize: 'win:minimize',
  winMaximizeToggle: 'win:maximizeToggle',
  winClose: 'win:close',
  winIsMaximized: 'win:isMaximized',
  winMaximizedChanged: 'win:maximizedChanged',
  appQuit: 'app:quit',
} as const;
