// Electron main process: creates the window, owns the PtyManager and the
// SidecarClient, and wires the renderer's IPC calls to both. The renderer never
// touches node-pty or the sidecar socket directly — everything is brokered here.
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PtyManager } from './pty-manager.js';
import { SidecarClient } from './sidecar.js';
import { Channels, type DirEntry, type Drive, type PersistedSession, type SpawnRequest } from './ipc.js';

let win: BrowserWindow | null = null;
let pty: PtyManager;
const sidecar = new SidecarClient();

function send(channel: string, ...args: unknown[]): void {
  win?.webContents.send(channel, ...args);
}

/**
 * Enumerate mountable filesystem roots so the folder tree can switch between them.
 * Windows: probe drive letters A:–Z: and keep the ones that exist. macOS/Unix: the
 * root `/` plus every mount under `/Volumes`.
 */
async function listDrives(): Promise<Drive[]> {
  if (process.platform === 'win32') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const probed = await Promise.all(
      letters.map(async (letter) => {
        const root = `${letter}:\\`;
        try {
          await access(root);
          return { label: `${letter}:`, path: root } as Drive;
        } catch {
          return null;
        }
      }),
    );
    return probed.filter((d): d is Drive => d !== null);
  }

  // macOS (and Unix): start at the root volume, then add anything mounted under
  // /Volumes (external disks, network shares, the boot volume's own symlink).
  const drives: Drive[] = [{ label: '/', path: '/' }];
  try {
    const vols = await readdir('/Volumes', { withFileTypes: true });
    for (const v of vols) {
      if (v.name.startsWith('.')) continue;
      if (v.isDirectory() || v.isSymbolicLink()) {
        drives.push({ label: v.name, path: `/Volumes/${v.name}` });
      }
    }
  } catch {
    /* no /Volumes (non-macOS Unix) — root alone is fine */
  }
  return drives;
}

function createWindow(): void {
  const isMac = process.platform === 'darwin';
  // Frameless custom chrome. macOS keeps its native traffic lights via the inset
  // title-bar style; Windows/Linux draw their own min/max/close buttons.
  const macChrome = isMac
    ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 14 } }
    : {};
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0d1117',
    title: 'portus',
    autoHideMenuBar: true,
    frame: false,
    ...macChrome,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  void win.loadFile(join(__dirname, '../renderer/index.html'));
  // Keep the renderer's max/restore button glyph in sync with the real state.
  win.on('maximize', () => send(Channels.winMaximizedChanged, true));
  win.on('unmaximize', () => send(Channels.winMaximizedChanged, false));
  win.on('closed', () => {
    win = null;
  });
}

function registerIpc(): void {
  ipcMain.handle(Channels.ptySpawn, (_e: IpcMainInvokeEvent, req: SpawnRequest) =>
    pty.spawn(req),
  );
  ipcMain.on(Channels.ptyWrite, (_e, id: string, data: string) => pty.write(id, data));
  ipcMain.on(Channels.ptyResize, (_e, id: string, cols: number, rows: number) =>
    pty.resize(id, cols, rows),
  );
  ipcMain.on(Channels.ptyKill, (_e, id: string) => pty.kill(id));

  ipcMain.handle(Channels.fsHome, (): string => homedir());
  ipcMain.handle(Channels.fsDrives, (): Promise<Drive[]> => listDrives());
  ipcMain.handle(Channels.fsListDir, async (_e, dirPath: string): Promise<DirEntry[]> => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(dirPath, e.name), isDirectory: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });

  ipcMain.handle(Channels.sessionList, () => sidecar.listSessions());
  ipcMain.handle(Channels.sessionSave, (_e, s: PersistedSession) => sidecar.saveSession(s));
  ipcMain.handle(Channels.sessionGet, (_e, id: string) => sidecar.getSession(id));
  ipcMain.handle(Channels.sessionDelete, (_e, id: string) => sidecar.deleteSession(id));
  ipcMain.handle(Channels.usageAdd, (_e, sessionId: string, tIn: number, tOut: number) =>
    sidecar.addUsage(sessionId, tIn, tOut),
  );

  ipcMain.on(Channels.winMinimize, () => win?.minimize());
  ipcMain.on(Channels.winMaximizeToggle, () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(Channels.winClose, () => win?.close());
  ipcMain.handle(Channels.winIsMaximized, (): boolean => win?.isMaximized() ?? false);
  ipcMain.on(Channels.appQuit, () => app.quit());
}

app.whenReady().then(async () => {
  pty = new PtyManager({
    onData: (id, data) => send(Channels.ptyData, id, data),
    onStatus: (id, status) => send(Channels.ptyStatus, id, status),
    onUsage: (id, tIn, tOut) => send(Channels.ptyUsage, id, tIn, tOut),
    onExit: (id, code) => send(Channels.ptyExit, id, code),
  });

  registerIpc();

  try {
    await sidecar.start(app.getAppPath(), join(app.getPath('userData'), 'portus.db'));
  } catch (err) {
    // The terminal half of the app still works without persistence; surface the
    // failure but don't block startup.
    console.error('[main] sidecar unavailable:', (err as Error).message);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  pty?.killAll();
  sidecar.dispose();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  pty?.killAll();
  sidecar.dispose();
});
