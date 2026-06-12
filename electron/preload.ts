// Context-isolated bridge. Exposes a typed `window.api` to the renderer; all
// privileged work happens in the main process. The matching type declaration
// lives in renderer/global.d.ts.
import { contextBridge, ipcRenderer } from 'electron';
import {
  Channels,
  type AppSettings,
  type DirEntry,
  type Drive,
  type PersistedSession,
  type SessionStatus,
  type SpawnRequest,
} from './ipc.js';

type Unsubscribe = () => void;

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): Unsubscribe {
  const handler = (_e: unknown, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api = {
  pty: {
    spawn: (req: SpawnRequest): Promise<string> => ipcRenderer.invoke(Channels.ptySpawn, req),
    write: (id: string, data: string): void => ipcRenderer.send(Channels.ptyWrite, id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send(Channels.ptyResize, id, cols, rows),
    kill: (id: string): void => ipcRenderer.send(Channels.ptyKill, id),
    onData: (cb: (id: string, data: string) => void): Unsubscribe =>
      on(Channels.ptyData, cb),
    onStatus: (cb: (id: string, status: SessionStatus) => void): Unsubscribe =>
      on(Channels.ptyStatus, cb),
    onUsage: (cb: (id: string, tokensIn: number, tokensOut: number) => void): Unsubscribe =>
      on(Channels.ptyUsage, cb),
    onExit: (cb: (id: string, exitCode: number) => void): Unsubscribe =>
      on(Channels.ptyExit, cb),
  },
  fs: {
    home: (): Promise<string> => ipcRenderer.invoke(Channels.fsHome),
    listDir: (path: string): Promise<DirEntry[]> => ipcRenderer.invoke(Channels.fsListDir, path),
    drives: (): Promise<Drive[]> => ipcRenderer.invoke(Channels.fsDrives),
  },
  sessions: {
    list: (): Promise<PersistedSession[]> => ipcRenderer.invoke(Channels.sessionList),
    save: (s: PersistedSession): Promise<PersistedSession> =>
      ipcRenderer.invoke(Channels.sessionSave, s),
    get: (id: string): Promise<PersistedSession | null> =>
      ipcRenderer.invoke(Channels.sessionGet, id),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(Channels.sessionDelete, id),
  },
  usage: {
    add: (sessionId: string, tokensIn: number, tokensOut: number): Promise<PersistedSession> =>
      ipcRenderer.invoke(Channels.usageAdd, sessionId, tokensIn, tokensOut),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(Channels.settingsGet),
    save: (settings: AppSettings): Promise<void> =>
      ipcRenderer.invoke(Channels.settingsSave, settings),
  },
  win: {
    minimize: (): void => ipcRenderer.send(Channels.winMinimize),
    maximizeToggle: (): void => ipcRenderer.send(Channels.winMaximizeToggle),
    close: (): void => ipcRenderer.send(Channels.winClose),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(Channels.winIsMaximized),
    onMaximizedChanged: (cb: (maximized: boolean) => void): Unsubscribe =>
      on(Channels.winMaximizedChanged, cb),
  },
  app: {
    quit: (): void => ipcRenderer.send(Channels.appQuit),
  },
  platform: process.platform,
};

export type PortusApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
