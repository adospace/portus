// Renderer entry point. Wires the panes together: builds the PaneManager (which
// owns tabs, sessions, and PTY routing), the LayoutManager (single/quad/six), the
// custom title bar, the folder tree, and the session history. Also installs the
// outer 3-pane resize splitters and routes main-process PTY events to the manager.
import Iconify from '@iconify/iconify';
import lucide from '@iconify-json/lucide/icons.json';
import { FolderTree } from './folder-tree';
import { SessionList } from './session-list';
import { PaneManager } from './pane-manager';
import { LayoutManager } from './layout';
import { TitleBar } from './titlebar';
import { Splitter } from './splitter';
import { SettingsStore } from './settings-store';

Iconify.addCollection(lucide);

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
  $<HTMLInputElement>('#session-search'),
);

const paneManager = new PaneManager({
  onSessionsChanged: () => sessionList.refresh(),
  settings: settingsStore,
});

const layout = new LayoutManager($('#layout-grid'), paneManager);

new TitleBar(
  (mode) => layout.setMode(mode),
  () => paneManager.openSettings(),
);

const folderTree = new FolderTree(
  $('#folder-tree'),
  $<HTMLSelectElement>('#drive-select'),
  () => settingsStore.commands(),
  (folder, command) => void paneManager.createSession(folder, { command }),
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

async function init(): Promise<void> {
  wireEvents();
  installOuterSplitters();
  await settingsStore.load();
  paneManager.setHomeDir(await window.api.fs.home());
  await folderTree.init();
  await sessionList.refresh();
  Iconify.scan();
}

void init();
