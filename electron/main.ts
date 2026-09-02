// Electron main process: creates the window, owns the PtyManager and the
// SessionStore, and wires the renderer's IPC calls to both. The renderer never
// touches node-pty or the session file directly — everything is brokered here.
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { access, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PtyManager } from './pty-manager.js';
import { SessionStore } from './session-store.js';
import {
  Channels,
  DEFAULT_GENERAL,
  DEFAULT_SETTINGS,
  type AppSettings,
  type ConfirmSaveChoice,
  type ContextUsage,
  type DirEntry,
  type Drive,
  type FileRead,
  type GeneralSettings,
  type GitFileStatus,
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

// --- File editor I/O ------------------------------------------------------
// The in-app Monaco editor reads/writes text files directly (no PTY, no
// session). Files that are binary or above the cap are reported as `binary` so
// the renderer hands them to the OS default handler instead.

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** Read a file for the editor: decoded UTF-8 text when it's a text-like file
 *  under the size cap, otherwise `binary` (binary content or too large). */
async function readFileForEditor(path: string): Promise<FileRead> {
  const s = await stat(path);
  if (!s.isFile() || s.size > MAX_TEXT_BYTES) return { kind: 'binary' };
  const buf = await readFile(path);
  // A NUL byte in the leading chunk is the classic "not a text file" signal.
  if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) return { kind: 'binary' };
  return { kind: 'text', content: buf.toString('utf8') };
}

/** Native unsaved-changes prompt shown when an edited editor tab is closed. */
async function confirmSave(name: string): Promise<ConfirmSaveChoice> {
  if (!win) return 'cancel';
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: `Do you want to save the changes you made to ${name}?`,
    detail: "Your changes will be lost if you don't save them.",
  });
  return res.response === 0 ? 'save' : res.response === 1 ? 'discard' : 'cancel';
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

/** Context-window size (denominator for the gauge) for a transcript's model.
 *  Most current Claude models ship a 1M-token window as standard — Opus 4.6/4.7/
 *  4.8, Sonnet 4.6, and Fable/Mythos 5 — while Haiku and the older 4.0/4.1/4.5
 *  families are 200k (those expose 1M only via an opt-in beta we can't see in the
 *  transcript). We key off the model id, defaulting unknown ids to 200k, then keep
 *  the original safety net: if occupancy ever exceeds the assumed limit (an
 *  undetected 1M variant, or a model newer than this list), bump the denominator
 *  so the gauge never pins at >100%. */
function contextLimitFor(tokens: number, model: string): number {
  const id = model.toLowerCase();
  const oneMillion =
    /claude-opus-4-[6-9]/.test(id) || // Opus 4.6+ (and forward)
    /claude-opus-[5-9]/.test(id) || // future Opus majors
    /claude-sonnet-4-[6-9]/.test(id) || // Sonnet 4.6+
    /claude-(fable|mythos)-\d/.test(id) || // Fable / Mythos
    /\[1m\]|[-_]1m\b/.test(id); // explicit 1M marker, if ever present
  let limit = oneMillion ? 1_000_000 : 200_000;
  if (tokens > limit) limit = tokens > 1_000_000 ? 2_000_000 : 1_000_000;
  return limit;
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
      return { tokens, limit: contextLimitFor(tokens, model), model };
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
// repo-name tooltip), and the status bar shows the active session's branch +
// working-tree change count. Branch/name come straight from the `.git` metadata
// (a few small file reads, fast enough per visible folder); the change count is
// the one thing that genuinely needs a `git` process, so it's only computed for
// the session status bar (`walkUp` callers), never the folder-tree marker.

const execFileAsync = promisify(execFile);

/** Resolve a folder's real gitdir + work-tree root, following the `.git`-as-a-file
 *  pointer used by linked worktrees / submodules. When `walkUp` is set, ancestor
 *  directories are searched too, so a session started in a repo subfolder still
 *  finds the repo's branch. Null if no git work tree is found. */
async function resolveGitDir(
  folder: string,
  walkUp: boolean,
): Promise<{ gitDir: string; root: string } | null> {
  let dir = folder;
  for (;;) {
    try {
      const dotGit = join(dir, '.git');
      const s = await stat(dotGit);
      if (s.isDirectory()) return { gitDir: dotGit, root: dir };
      // `.git` is a file holding "gitdir: <path>" (linked worktree / submodule).
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'));
      if (m) return { gitDir: isAbsolute(m[1]!) ? m[1]! : join(dir, m[1]!), root: dir };
    } catch {
      /* no .git here, unreadable, etc. — try the parent if asked */
    }
    if (!walkUp) return null;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/** Repo name from the `origin` remote in `<gitDir>/config` (last URL segment,
 *  sans `.git`), falling back to the work-tree's folder name. */
async function repoName(gitDir: string, root: string): Promise<string> {
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
  return basename(root.replace(/[/\\]+$/, '')) || root;
}

/** Count changed files in a work tree via `git status --porcelain` (staged,
 *  unstaged, and untracked). Best-effort: 0 if git is missing or errors out. */
async function countChanges(root: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0; // git not installed, not a repo anymore, etc.
  }
}

/** Categorise a porcelain `XY` status pair into a single decoration class. */
function categorizeStatus(xy: string): GitFileStatus['status'] {
  if (xy === '??') return 'untracked';
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return 'conflict';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

// Per-repo working-tree status, cached briefly so expanding several folders in the
// same repo in quick succession doesn't spawn `git` once per folder.
const STATUS_TTL_MS = 1500;
const statusCache = new Map<string, { at: number; data: GitFileStatus[] }>();

/** Working-tree status of every changed path in `folder`'s repo, as absolute
 *  paths. Resolves the repo root (walking up) so a subfolder query still covers
 *  the whole repo; empty when `folder` isn't in a git work tree. */
async function gitFileStatuses(folder: string): Promise<GitFileStatus[]> {
  const resolved = await resolveGitDir(folder, true);
  if (!resolved) return [];
  const { root } = resolved;
  const now = Date.now();
  const cached = statusCache.get(root);
  if (cached && now - cached.at < STATUS_TTL_MS) return cached.data;

  let data: GitFileStatus[] = [];
  try {
    // -z: NUL-separated, no path quoting. A rename emits "<new>\0<old>", so the
    // entry after a renamed one is its old path and must be skipped.
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z'], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parts = stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (!e || e.length < 3) continue;
      const status = categorizeStatus(e.slice(0, 2));
      data.push({ path: join(root, e.slice(3)), status });
      if (status === 'renamed') i++; // skip the trailing old path
    }
  } catch {
    data = []; // git missing / not a repo anymore
  }
  statusCache.set(root, { at: now, data });
  return data;
}

/** Git metadata for `folder` (branch + repo name, plus change count + root when
 *  `walkUp`), or null if it isn't (and — with `walkUp` — isn't inside) a git work
 *  tree. Branch/name are read from `.git`; only the walk-up path spawns `git` for
 *  the change count, so the folder-tree marker stays cheap. */
async function readGitInfo(folder: string, walkUp: boolean): Promise<GitInfo | null> {
  const resolved = await resolveGitDir(folder, walkUp);
  if (!resolved) return null;
  const { gitDir, root } = resolved;
  try {
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    const branch = ref ? ref[1]! : head.slice(0, 7); // detached HEAD → short SHA
    if (!branch) return null;
    const changes = walkUp ? await countChanges(root) : 0;
    return { branch, name: await repoName(gitDir, root), changes, root };
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
      showSessions:
        typeof g.showSessions === 'boolean' ? g.showSessions : DEFAULT_GENERAL.showSessions,
    };
    return {
      commands: Array.isArray(parsed.commands) ? parsed.commands : DEFAULT_SETTINGS.commands,
      general,
      pinnedFolders: Array.isArray(parsed.pinnedFolders)
        ? parsed.pinnedFolders.filter((f): f is string => typeof f === 'string')
        : DEFAULT_SETTINGS.pinnedFolders,
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
  ipcMain.handle(Channels.fsReadFile, (_e, path: string): Promise<FileRead> =>
    readFileForEditor(path),
  );
  ipcMain.handle(Channels.fsWriteFile, async (_e, path: string, content: string): Promise<void> => {
    await writeFile(path, content, 'utf8');
  });
  ipcMain.handle(Channels.dialogConfirmSave, (_e, name: string): Promise<ConfirmSaveChoice> =>
    confirmSave(name),
  );
  ipcMain.handle(Channels.shellOpenPath, (_e, path: string): Promise<string> =>
    shell.openPath(path),
  );
  ipcMain.handle(Channels.shellTrashItem, (_e, path: string): Promise<void> =>
    shell.trashItem(path),
  );
  ipcMain.handle(Channels.fsListDir, async (_e, dirPath: string): Promise<DirEntry[]> => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    // Hide dot-entries only where a leading dot *means* hidden (macOS/Linux). On
    // Windows the hidden flag is a file attribute, not a naming convention, so
    // `.certs` / `.github` / `.claude` are ordinary folders the user expects to
    // find in the tree — and legitimate places to start a session.
    const hideDotfiles = process.platform !== 'win32';
    return entries
      .filter((e) => !(hideDotfiles && e.name.startsWith('.')))
      .map((e) => ({ name: e.name, path: join(dirPath, e.name), isDirectory: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  });

  ipcMain.handle(Channels.gitInfo, (_e, folder: string, walkUp?: boolean): Promise<GitInfo | null> =>
    readGitInfo(folder, walkUp ?? false),
  );

  ipcMain.handle(Channels.gitStatus, (_e, folder: string): Promise<GitFileStatus[]> =>
    gitFileStatuses(folder),
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
    onTitle: (id, title) => send(Channels.ptyTitle, id, title),
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
