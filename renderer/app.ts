// Renderer entry point. Wires the panes together: builds the PaneManager (which
// owns tabs, sessions, and PTY routing), the LayoutManager (single/quad/six), the
// custom title bar, the folder tree, and the session history. Also installs the
// outer 3-pane resize splitters and routes main-process PTY events to the manager.
import 'iconify-icon'; // registers the <iconify-icon> web component
import { addCollection } from 'iconify-icon';
import lucide from '@iconify-json/lucide/icons.json';
import { FolderTree } from './folder-tree';
import { PinnedFolders } from './pinned-folders';
import { SessionList } from './session-list';
import { PaneManager } from './pane-manager';
import { LayoutManager } from './layout';
import { TitleBar } from './titlebar';
import { Splitter } from './splitter';
import { SettingsStore } from './settings-store';
import { ThemeManager } from './theme';

// Register the Lucide icons offline so the web component never hits the network.
addCollection(lucide);

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

const settingsStore = new SettingsStore();

const sessionList = new SessionList(
  $('#session-list'),
  (s) =>
    void paneManager.createSession(s.folder, {
      persistentId: s.id,
      claudeId: s.claudeId,
      title: s.title,
    }),
  () => settingsStore.commands(),
  (folder, command) => void paneManager.createSession(folder, { command }),
  (folder) => pinnedFolders.pin(folder),
  $<HTMLInputElement>('#session-search'),
);

const paneManager = new PaneManager({
  onSessionsChanged: () => sessionList.refresh(),
  settings: settingsStore,
  onActiveFolderChanged: (folder) => {
    void folderTree.highlightFolder(folder);
    sessionList.setActiveFolder(folder);
  },
  onPinFolder: (folder) => pinnedFolders.pin(folder),
});

// Resolve and apply the theme as early as possible (from the localStorage cache)
// so first paint matches; settings load below confirms the authoritative choice.
// xterm reads colors once, so re-theme all terminals when the scheme flips.
const themeManager = new ThemeManager(() => paneManager.applyTerminalTheme());
paneManager.setThemeManager(themeManager);

const layout = new LayoutManager($('#layout-grid'), paneManager);

const titleBar = new TitleBar(
  (mode) => layout.setMode(mode),
  () => paneManager.openSettings(),
);

// Let the pane manager drive layout changes (e.g. "move tab to a new group"),
// keeping the title-bar's active-mode highlight in sync.
paneManager.setLayoutController((mode) => {
  layout.setMode(mode);
  titleBar.setActive(mode);
});

const folderTree = new FolderTree(
  $('#folder-tree'),
  $<HTMLSelectElement>('#drive-select'),
  () => settingsStore.commands(),
  (folder, command) => void paneManager.createSession(folder, { command }),
  (folder) => pinnedFolders.pin(folder),
  (folder) => sessionList.setSelectedFolder(folder),
  (path) => void paneManager.openFile(path),
);

// Bottom of the left pane: pinned folders for quick access. Clicking one opens
// the command menu to launch a session there; the list persists in settings.
const pinnedFolders = new PinnedFolders(
  $('#pinned-panel'),
  $('#pinned-list'),
  () => settingsStore.commands(),
  (folder, command) => void paneManager.createSession(folder, { command }),
  (folders) => void settingsStore.setPinned(folders),
);

// --- Outer 3-pane resize ---------------------------------------------------
function installOuterSplitters(): void {
  const shell = $('#shell');
  const leftAside = shell.firstElementChild as HTMLElement;
  const rightAside = shell.lastElementChild as HTMLElement;
  const leftGutter = shell.querySelector<HTMLElement>('[data-gutter="left"]')!;
  const rightGutter = shell.querySelector<HTMLElement>('[data-gutter="right"]')!;
  const reserve = 500; // keep room for the center + opposite side pane

  new Splitter({
    gutter: leftGutter,
    axis: 'col',
    get: () => leftAside.offsetWidth,
    set: (px) => shell.style.setProperty('--col-left', `${px}px`),
    min: 160,
    max: () => Math.max(160, shell.clientWidth - reserve),
    onResize: () => paneManager.refitAll(),
  });

  new Splitter({
    gutter: rightGutter,
    axis: 'col',
    sign: -1, // controlled track sits after the gutter
    get: () => rightAside.offsetWidth,
    set: (px) => shell.style.setProperty('--col-right', `${px}px`),
    min: 160,
    max: () => Math.max(160, shell.clientWidth - reserve),
    onResize: () => paneManager.refitAll(),
  });
}

// --- Main-process event routing -------------------------------------------
function wireEvents(): void {
  window.api.pty.onData((id, data) => paneManager.routeData(id, data));
  window.api.pty.onStatus((id, status) => paneManager.routeStatus(id, status));
  window.api.pty.onUsage((id, tIn, tOut) => paneManager.routeUsage(id, tIn, tOut));
  window.api.pty.onExit((id) => paneManager.routeExit(id));
}

// Tick the elapsed timers for busy tabs.
setInterval(() => paneManager.tickElapsed(), 250);

// Poll each session's context-window fill (cheap transcript tail reads).
setInterval(() => void paneManager.refreshContext(), 4000);

async function init(): Promise<void> {
  wireEvents();
  installOuterSplitters();
  await settingsStore.load();
  // Apply the persisted (authoritative) theme now that settings are loaded.
  themeManager.set(settingsStore.general().theme);
  pinnedFolders.setFolders(settingsStore.pinned());
  paneManager.setHomeDir(await window.api.fs.home());
  await folderTree.init();
  await sessionList.refresh();
  // No scan step needed: the <iconify-icon> web component renders itself and
  // updates whenever its `icon` attribute changes — including nodes added later.
}

void init();
