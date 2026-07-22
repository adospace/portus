// One section of the center area: a self-contained tab group with its own tab
// bar (+ new-session button), its own terminal stack, and its own active tab.
// A single-view layout has one Pane; quad has four; six has six. The PaneManager
// owns the set of panes and routes PTY events; a Pane only manages its own DOM
// and tab set, delegating privileged work (spawn/kill/resize, status bar) back
// to the manager through callbacks.
import type { ContextUsage } from '../electron/ipc';

/**
 * The minimal surface a Pane needs from whatever fills a tab — a real terminal
 * (TerminalTab) or a special view like the Settings panel (SettingsView). `feed`
 * is terminal-only and therefore optional.
 */
export interface TabContent {
  show(): void;
  hide(): void;
  reparent(parent: HTMLElement): void;
  fit(): { cols: number; rows: number };
  dispose(): void;
  feed?(data: string): void;
  /** Re-read theme colors after a light/dark switch (terminal-only). */
  applyTheme?(): void;
}

/** What kind of content a tab holds — terminals route PTY events, views don't. */
export type TabKind = 'terminal' | 'settings' | 'editor';

export interface Tab {
  kind: TabKind;
  persistentId: string;
  ptyId: string;
  folder: string;
  /** Agent-supplied title (terminal OSC). Null → label falls back to folder name.
   *  Agent CLIs animate a glyph in here while they work, so this doubles as the
   *  tab's liveness indicator — the app adds no status of its own. */
  title: string | null;
  /** Claude session id to `--resume`, when one is known (persisted with the row). */
  claudeId: string | null;
  /** When this session/tab was created (epoch ms). Used to ignore transcripts
   *  that predate it, so a fresh session never reads a prior run's context. */
  startedAt: number;
  totalCost: number;
  totalTokens: number;
  /** Context-window occupancy of the backing session, polled from its transcript. */
  context: ContextUsage | null;
  /** Current git branch of the session's folder, resolved by walking up to the
   *  nearest ancestor repo (null = not a repo / unknown), shown in the status bar.
   *  Polled alongside context. */
  branch: string | null;
  /** Number of changed files in the session's repo (working tree). Shown as a
   *  clickable badge in the status bar; 0 = clean / unknown. Polled with branch. */
  changes: number;
  /** Work-tree root of the session's repo (null = not a repo), used as the cwd
   *  for the diff tab opened from the change badge. */
  gitRoot: string | null;
  term: TabContent;
  btn: HTMLButtonElement;
  /** Leading glyph for non-terminal tabs (Settings/editor). Terminal tabs carry
   *  no app-drawn icon — whatever the agent puts in its title is the icon. */
  icon: HTMLElement;
  /** True once the backing PTY exited; the label dims to mark a dead session. */
  exited: boolean;
}

export interface PaneCallbacks {
  /** The pane gained focus (pointerdown / focusin) — make it the active pane. */
  onActivated: (pane: Pane) => void;
  /** This pane's active tab changed — repaint the status bar if it's active. */
  onTabActivated: (pane: Pane, ptyId: string) => void;
  /** The + button was clicked; `anchor` is the button, for positioning a menu. */
  onNewTab: (pane: Pane, anchor: HTMLElement) => void;
  /** A tab button was clicked — resolve owning pane via the manager's index. */
  onTabClicked: (ptyId: string) => void;
  /** The close (×) on a tab was clicked. */
  onCloseTab: (ptyId: string) => void;
  /** A tab was right-clicked — open its context menu at (x, y). */
  onTabContextMenu: (ptyId: string, x: number, y: number) => void;
  /** The last tab was removed from this pane. */
  onEmpty: (pane: Pane) => void;
  /** Fit produced new dimensions — resize the backing PTY. */
  resize: (ptyId: string, cols: number, rows: number) => void;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Compact token count for tooltips: 126000 → "126k", 1_200_000 → "1.2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// Render an icon into a stable wrapper via the <iconify-icon> web component, so
// listeners/transforms on the wrapper survive icon changes (the component renders
// itself immediately and re-renders when its `icon` attribute changes).
function setIcon(wrapper: HTMLElement, icon: string): void {
  wrapper.innerHTML = `<iconify-icon icon="${icon}"></iconify-icon>`;
}

export class Pane {
  readonly root: HTMLDivElement;
  readonly stackEl: HTMLDivElement;
  private readonly tabBarEl: HTMLDivElement;
  private readonly newTabBtn: HTMLButtonElement;
  private readonly tabs = new Map<string, Tab>();
  private activeTabId: string | null = null;
  private readonly ro: ResizeObserver;
  private raf = 0;

  constructor(private readonly cb: PaneCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'flex flex-col h-full min-h-0 min-w-0';

    this.tabBarEl = document.createElement('div');
    this.tabBarEl.className =
      'tab-scroll flex items-stretch gap-1 h-9 px-2 border-b border-edge bg-panel shrink-0 ' +
      'overflow-x-auto overflow-y-hidden';

    this.newTabBtn = document.createElement('button');
    this.newTabBtn.title = 'New session';
    this.newTabBtn.className =
      'flex items-center justify-center w-8 shrink-0 text-muted hover:text-fg';
    setIcon(this.newTabBtn, 'lucide:plus');
    this.newTabBtn.addEventListener('click', () => this.cb.onNewTab(this, this.newTabBtn));
    this.tabBarEl.appendChild(this.newTabBtn);

    this.stackEl = document.createElement('div');
    this.stackEl.className = 'relative flex-1 min-h-0 bg-bg';

    this.root.append(this.tabBarEl, this.stackEl);

    // Clicking/focusing anywhere in the pane makes it the active pane.
    this.root.addEventListener('pointerdown', () => this.cb.onActivated(this));
    this.root.addEventListener('focusin', () => this.cb.onActivated(this));

    // Refit the active terminal when this pane's stack changes size.
    this.ro = new ResizeObserver(() => {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.refitActive();
      });
    });
    this.ro.observe(this.stackEl);
  }

  // --- tab set ----------------------------------------------------------

  addTab(tab: Tab): void {
    this.buildTabButton(tab);
    this.tabBarEl.insertBefore(tab.btn, this.newTabBtn);
    this.tabs.set(tab.ptyId, tab);
    this.activateTab(tab.ptyId);
  }

  /** Remove and dispose a tab (genuine close). */
  removeTab(ptyId: string): void {
    const tab = this.tabs.get(ptyId);
    if (!tab) return;
    tab.term.dispose();
    tab.btn.remove();
    this.tabs.delete(ptyId);
    if (this.activeTabId === ptyId) {
      const next = [...this.tabs.keys()][0] ?? null;
      this.activeTabId = null;
      if (next) this.activateTab(next);
      else this.cb.onEmpty(this);
    }
  }

  /** Detach a tab WITHOUT disposing its terminal — for relocation. */
  releaseTab(ptyId: string): Tab | undefined {
    const tab = this.tabs.get(ptyId);
    if (!tab) return undefined;
    tab.btn.remove();
    this.tabs.delete(ptyId);
    if (this.activeTabId === ptyId) this.activeTabId = null;
    return tab;
  }

  /** Receive a tab released from another pane (kept hidden until activated). */
  adoptTab(tab: Tab): void {
    tab.term.reparent(this.stackEl);
    tab.term.hide();
    this.tabBarEl.insertBefore(tab.btn, this.newTabBtn);
    this.tabs.set(tab.ptyId, tab);
  }

  activateTab(ptyId: string): void {
    if (!this.tabs.has(ptyId)) return;
    this.activeTabId = ptyId;
    for (const [id, tab] of this.tabs) {
      const isActive = id === ptyId;
      if (isActive) tab.term.show();
      else tab.term.hide();
      tab.btn.classList.toggle('tab-active', isActive);
    }
    const tab = this.tabs.get(ptyId);
    if (tab) this.fitTab(tab);
    this.cb.onTabActivated(this, ptyId);
  }

  // --- accessors --------------------------------------------------------

  get(ptyId: string): Tab | undefined {
    return this.tabs.get(ptyId);
  }

  has(ptyId: string): boolean {
    return this.tabs.has(ptyId);
  }

  tabIds(): string[] {
    return [...this.tabs.keys()];
  }

  tabList(): Tab[] {
    return [...this.tabs.values()];
  }

  count(): number {
    return this.tabs.size;
  }

  activeTab(): Tab | undefined {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
  }

  // --- painting ---------------------------------------------------------

  setActiveHighlight(on: boolean): void {
    this.root.classList.toggle('pane-active', on);
  }

  /** Refit the active terminal and resize its PTY. */
  refitActive(): void {
    const tab = this.activeTab();
    if (tab) this.fitTab(tab);
  }

  dispose(): void {
    this.ro.disconnect();
    this.root.remove();
  }

  // --- internals --------------------------------------------------------

  private fitTab(tab: Tab): void {
    const dims = tab.term.fit();
    if (tab.kind === 'terminal') this.cb.resize(tab.ptyId, dims.cols, dims.rows);
  }

  private buildTabButton(tab: Tab): void {
    const btn = tab.btn;
    btn.className =
      'group relative overflow-hidden flex items-center gap-2 px-3 h-7 my-1 rounded text-sm ' +
      'whitespace-nowrap border border-transparent hover:border-edge';

    const close = document.createElement('span');
    close.className =
      'shrink-0 flex items-center opacity-0 group-hover:opacity-100 hover:text-accent cursor-pointer';
    setIcon(close, 'lucide:x');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onCloseTab(tab.ptyId);
    });
    btn.addEventListener('click', () => this.cb.onTabClicked(tab.ptyId));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cb.onTabContextMenu(tab.ptyId, e.clientX, e.clientY);
    });

    // Non-terminal views (Settings) get a static icon + fixed label.
    if (tab.kind === 'settings') {
      tab.icon.className = 'shrink-0 flex items-center text-muted';
      setIcon(tab.icon, 'lucide:settings');
      const name = document.createElement('span');
      name.textContent = 'Settings';
      btn.replaceChildren(tab.icon, name, close);
      return;
    }

    // Editor tabs: file icon + file name, plus a dirty dot (●) that the close ×
    // replaces on hover (VS Code-style).
    if (tab.kind === 'editor') {
      tab.icon.className = 'shrink-0 flex items-center text-muted';
      setIcon(tab.icon, 'lucide:file-pen');
      const name = document.createElement('span');
      name.className = 'tab-name truncate max-w-[20ch]';
      name.textContent = baseName(tab.folder);
      name.title = tab.folder;
      const dirty = document.createElement('span');
      dirty.className = 'tab-dirty shrink-0 w-2 h-2 rounded-full bg-fg hidden group-hover:hidden';
      btn.replaceChildren(tab.icon, name, dirty, close);
      return;
    }

    // Terminal tabs are label-only: no app-drawn status glyph and no elapsed
    // timer. Both used to appear and disappear as output came and went, which
    // resized the tab and made the whole bar flicker. The agent's own title —
    // which it animates while working — carries that signal instead, and a
    // fixed-width label keeps the tab bar still.
    const name = document.createElement('span');
    name.className = 'tab-name truncate max-w-[20ch]';
    name.textContent = tab.title || baseName(tab.folder);
    name.title = tab.title || tab.folder;

    // Thin context-fill bar along the bottom edge of the tab (painted by paintContext).
    const ctx = document.createElement('span');
    ctx.className = 'tab-ctx absolute left-0 bottom-0 h-[2px] rounded-full';
    ctx.style.width = '0';

    btn.replaceChildren(name, close, ctx);
  }

  /** Dim a terminal tab's label once its PTY has exited (a dead session). */
  markExited(ptyId: string): void {
    const tab = this.tabs.get(ptyId);
    if (!tab || tab.kind !== 'terminal') return;
    tab.exited = true;
    tab.btn.querySelector<HTMLElement>('.tab-name')?.classList.add('opacity-40');
  }

  /** Paint the per-tab context-fill bar: green → amber (≥80%) → red (≥95%). */
  paintContext(tab: Tab): void {
    if (tab.kind !== 'terminal') return;
    const bar = tab.btn.querySelector<HTMLElement>('.tab-ctx');
    if (!bar) return;
    const c = tab.context;
    if (!c || c.limit <= 0 || c.tokens <= 0) {
      bar.style.width = '0';
      tab.btn.title = '';
      return;
    }
    const pct = Math.min(100, (c.tokens / c.limit) * 100);
    const tone = pct >= 95 ? 'bg-danger' : pct >= 80 ? 'bg-warn' : 'bg-idle';
    bar.className = `tab-ctx absolute left-0 bottom-0 h-[2px] rounded-full ${tone}`;
    bar.style.width = `${pct}%`;
    tab.btn.title =
      `Context ${Math.round(pct)}% · ${fmtTokens(c.tokens)} / ${fmtTokens(c.limit)}` +
      (pct >= 80 ? ' · consider /compact or a fresh session' : '');
  }

  /** Toggle an editor tab's dirty dot (shown when it has unsaved changes). */
  setDirty(ptyId: string, dirty: boolean): void {
    const tab = this.tabs.get(ptyId);
    if (!tab || tab.kind !== 'editor') return;
    tab.btn.querySelector<HTMLElement>('.tab-dirty')?.classList.toggle('hidden', !dirty);
  }

  /** Update a terminal tab's display title (from the agent's terminal title). */
  setTitle(ptyId: string, title: string): void {
    const tab = this.tabs.get(ptyId);
    if (!tab || tab.kind !== 'terminal') return;
    tab.title = title;
    const name = tab.btn.querySelector<HTMLElement>('.tab-name');
    if (name) {
      name.textContent = title || baseName(tab.folder);
      name.title = title || tab.folder;
    }
  }
}
