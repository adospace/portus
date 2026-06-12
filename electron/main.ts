// Electron main process: creates the window, owns the PtyManager and the
// SidecarClient, and wires the renderer's IPC calls to both. The renderer never
// touches node-pty or the sidecar socket directly — everything is brokered here.
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { access, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PtyManager } from './pty-manager.js';
import { SidecarClient } from './sidecar.js';
import {
  Channels,
  DEFAULT_SETTINGS,
  type AppSettings,
  type ContextUsage,
  type DirEntry,
  type Drive,
  type PersistedSession,
  type SpawnRequest,
} from './ipc.js';

// On some Windows GPU/driver combos the compositor locks the WebGL present path
// to half refresh (~30fps) whenever the terminal canvas redraws every frame — so
// fast typing surfaces 2-3 chars per visual frame and feels laggy, even though the
// keystroke→echo round trip is ~5ms. Lifting the vsync / frame-rate throttle lets
// the renderer present each change immediately. Must be set before app ready.
app.commandLine.appendSwitch('disable-gpu-vsync');
app.commandLine.appendSwitch('disable-frame-rate-limit');

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

// --- Context-window gauge -------------------------------------------------
// Claude Code writes a per-session transcript at
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. The latest assistant
// entry's usage tells us how full the context window is, which drives the
// per-tab "heaviness" gauge (when to /compact or start fresh).

const CONTEXT_TAIL_BYTES = 256 * 1024;

/** Loose shape of the transcript fields we read. */
interface TranscriptUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
interface TranscriptEntry {
  message?: { usage?: TranscriptUsage; model?: string };
  usage?: TranscriptUsage;
  model?: string;
}

/** Map a working folder to Claude Code's project-dir name (non-alphanumerics → '-'). */
function encodeProjectDir(folder: string): string {
  return folder.replace(/[/\\]+$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** Standard Claude context is 200k; 1M-context variants can't be told apart by
 *  model id, so bump the denominator once occupancy clearly exceeds 200k. */
function contextLimitFor(tokens: number): number {
  return tokens > 200_000 ? 1_000_000 : 200_000;
}

/** Newest .jsonl transcript for a folder = the live session for that directory. */
async function newestTranscript(folder: string): Promise<string | null> {
  const dir = join(homedir(), '.claude', 'projects', encodeProjectDir(folder));
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null; // no transcripts for this folder yet
  }
  let newest: { path: string; mtime: number } | null = null;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const p = join(dir, e.name);
    try {
      const s = await stat(p);
      if (!newest || s.mtimeMs > newest.mtime) newest = { path: p, mtime: s.mtimeMs };
    } catch {
      /* skip unreadable */
    }
  }
  return newest?.path ?? null;
}

async function readContextUsage(folder: string): Promise<ContextUsage | null> {
  const file = await newestTranscript(folder);
  if (!file) return null;
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    // Read only the tail — the latest assistant entry is near the end, and the
    // file can be many MB. Drop the first (likely partial) line.
    const len = Math.min(size, CONTEXT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }
      const usage = entry.message?.usage ?? entry.usage;
      if (!usage) continue;
      const tokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      if (tokens <= 0) continue;
      const model = entry.message?.model ?? entry.model ?? '';
      return { tokens, limit: contextLimitFor(tokens), model };
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
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

  ipcMain.handle(Channels.contextGet, (_e, folder: string): Promise<ContextUsage | null> =>
    readContextUsage(folder),
  );

  ipcMain.handle(Channels.sessionList, () => sidecar.listSessions());
  ipcMain.handle(Channels.sessionSave, (_e, s: PersistedSession) => sidecar.saveSession(s));
  ipcMain.handle(Channels.sessionGet, (_e, id: string) => sidecar.getSession(id));
  ipcMain.handle(Channels.sessionDelete, (_e, id: string) => sidecar.deleteSession(id));
  ipcMain.handle(Channels.usageAdd, (_e, sessionId: string, tIn: number, tOut: number) =>
    sidecar.addUsage(sessionId, tIn, tOut),
  );

  // User settings live as a JSON file in the per-user app data dir, so they
  // survive restarts independently of the sidecar's SQLite session store.
  const settingsPath = (): string => join(app.getPath('userData'), 'settings.json');
  ipcMain.handle(Channels.settingsGet, async (): Promise<AppSettings> => {
    try {
      const parsed = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<AppSettings>;
      return { commands: Array.isArray(parsed.commands) ? parsed.commands : DEFAULT_SETTINGS.commands };
    } catch {
      // No file yet (first run) or unreadable/corrupt — fall back to defaults.
      return DEFAULT_SETTINGS;
    }
  });
  ipcMain.handle(Channels.settingsSave, async (_e, settings: AppSettings): Promise<void> => {
    await writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  });

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
