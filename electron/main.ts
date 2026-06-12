// Electron main process: creates the window, owns the PtyManager and the
// SessionStore, and wires the renderer's IPC calls to both. The renderer never
// touches node-pty or the session file directly — everything is brokered here.
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { access, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { PtyManager } from './pty-manager.js';
import { SessionStore } from './session-store.js';
import {
  Channels,
  DEFAULT_GENERAL,
  DEFAULT_SETTINGS,
  type AppSettings,
  type ContextUsage,
  type DirEntry,
  type Drive,
  type GeneralSettings,
  type GitInfo,
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
let store: SessionStore;

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

/** Newest .jsonl transcript for a folder = the live session for that directory.
 *  `since` (epoch ms), when given, excludes transcripts last modified before it —
 *  so a fresh session never picks up a prior run's leftover transcript. */
async function newestTranscript(folder: string, since?: number): Promise<string | null> {
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
      if (since && s.mtimeMs < since) continue; // predates this session — not ours
      if (!newest || s.mtimeMs > newest.mtime) newest = { path: p, mtime: s.mtimeMs };
    } catch {
      /* skip unreadable */
    }
  }
  return newest?.path ?? null;
}

async function readContextUsage(folder: string, since?: number): Promise<ContextUsage | null> {
  const file = await newestTranscript(folder, since);
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

// --- Git info --------------------------------------------------------------
// The folder tree marks directories that are git work trees (a small symbol +
// repo-name tooltip), and the status bar shows the active session's branch. We
// read both straight from the `.git` metadata rather than spawning `git` — a
// few small file reads, fast enough to call per visible folder.

/** Resolve a folder's real gitdir, following the `.git`-as-a-file pointer used
 *  by linked worktrees / submodules. Null if `folder` isn't a git work tree. */
async function resolveGitDir(folder: string): Promise<string | null> {
  try {
    const dotGit = join(folder, '.git');
    const s = await stat(dotGit);
    if (s.isDirectory()) return dotGit;
    // `.git` is a file holding "gitdir: <path>" (linked worktree / submodule).
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'));
    if (!m) return null;
    return isAbsolute(m[1]!) ? m[1]! : join(folder, m[1]!);
  } catch {
    return null; // no .git, unreadable, etc.
  }
}

/** Repo name from the `origin` remote in `<gitDir>/config` (last URL segment,
 *  sans `.git`), falling back to the work-tree's folder name. */
async function repoName(gitDir: string, folder: string): Promise<string> {
  try {
    const cfg = await readFile(join(gitDir, 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?\n\s*url\s*=\s*(.+?)\s*$/ms.exec(cfg);
    if (m) {
      const url = m[1]!.replace(/\.git$/, '').replace(/[/\\]+$/, '');
      const seg = url.split(/[/\\:]/).filter(Boolean).pop();
      if (seg) return seg;
    }
  } catch {
    /* no config / no origin — fall through to the folder name */
  }
  return basename(folder.replace(/[/\\]+$/, '')) || folder;
}

/** Git metadata for `folder` (current branch + repo name), or null if it isn't a
 *  git work tree. Reads `.git/HEAD` and `.git/config`; no `git` process. */
async function readGitInfo(folder: string): Promise<GitInfo | null> {
  const gitDir = await resolveGitDir(folder);
  if (!gitDir) return null;
  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    const branch = ref ? ref[1]! : head.slice(0, 7); // detached HEAD → short SHA
    if (!branch) return null;
    return { branch, name: await repoName(gitDir, folder) };
  } catch {
    return null;
  }
}

// --- User settings ---------------------------------------------------------
// Settings live as a separate JSON file in the per-user app data dir, so they
// survive restarts independently of the session store.

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/** Read settings from disk, normalising missing/invalid fields to defaults. */
async function readSettings(): Promise<AppSettings> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<AppSettings>;
    const g = (parsed.general ?? {}) as Partial<GeneralSettings>;
    const theme =
      g.theme === 'light' || g.theme === 'dark' || g.theme === 'system'
        ? g.theme
        : DEFAULT_GENERAL.theme;
    const general: GeneralSettings = {
      defaultFolder: typeof g.defaultFolder === 'string' ? g.defaultFolder : DEFAULT_GENERAL.defaultFolder,
      sessionRetentionDays:
        typeof g.sessionRetentionDays === 'number' && g.sessionRetentionDays > 0
          ? g.sessionRetentionDays
          : DEFAULT_GENERAL.sessionRetentionDays,
      theme,
    };
    return {
      commands: Array.isArray(parsed.commands) ? parsed.commands : DEFAULT_SETTINGS.commands,
      general,
    };
  } catch {
    // No file yet (first run) or unreadable/corrupt — fall back to defaults.
    return DEFAULT_SETTINGS;
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
    title: 'PORTUS',
    icon: join(__dirname, '../renderer/icon.png'),
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
  ipcMain.handle(Channels.fsPickFolder, async (): Promise<string | null> => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]!;
  });
  ipcMain.handle(Channels.shellOpenPath, (_e, path: string): Promise<string> =>
    shell.openPath(path),
  );
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

  ipcMain.handle(Channels.gitInfo, (_e, folder: string): Promise<GitInfo | null> =>
    readGitInfo(folder),
  );

  ipcMain.handle(Channels.contextGet, (_e, folder: string, since?: number): Promise<ContextUsage | null> =>
    readContextUsage(folder, since),
  );

  ipcMain.handle(Channels.sessionList, () => store.list());
  ipcMain.handle(Channels.sessionSave, (_e, s: PersistedSession) => store.save(s));
  ipcMain.handle(Channels.sessionGet, (_e, id: string) => store.get(id));
  ipcMain.handle(Channels.sessionDelete, (_e, id: string) => store.delete(id));
  ipcMain.handle(Channels.usageAdd, (_e, sessionId: string, tIn: number, tOut: number) =>
    store.addUsage(sessionId, tIn, tOut, new Date().toISOString()),
  );

  ipcMain.handle(Channels.settingsGet, (): Promise<AppSettings> => readSettings());
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

  store = new SessionStore(join(app.getPath('userData'), 'sessions.json'));

  // Prune session history older than the configured retention window (default 30d).
  const { general } = await readSettings();
  if (general.sessionRetentionDays > 0) {
    const cutoff = new Date(Date.now() - general.sessionRetentionDays * 86_400_000).toISOString();
    store.pruneOlderThan(cutoff);
  }

  registerIpc();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  pty?.killAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  pty?.killAll();
});
