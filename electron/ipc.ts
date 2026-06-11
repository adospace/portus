// Shared IPC contract between the Electron main process, the preload bridge,
// and the renderer. Keeping the channel names and payload shapes in one place
// avoids drift between the three layers.

export type SessionStatus = 'busy' | 'idle' | 'done';

export interface PersistedSession {
  id: string;
  folder: string;
  claudeId: string | null;
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
  sessionList: 'session:list',
  sessionSave: 'session:save',
  sessionGet: 'session:get',
  sessionDelete: 'session:delete',
  usageAdd: 'usage:add',
  winMinimize: 'win:minimize',
  winMaximizeToggle: 'win:maximizeToggle',
  winClose: 'win:close',
  winIsMaximized: 'win:isMaximized',
  winMaximizedChanged: 'win:maximizedChanged',
  appQuit: 'app:quit',
} as const;
