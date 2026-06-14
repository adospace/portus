// Orchestrates the set of panes: owns the ordered Pane[], the single globally
// active pane, the ptyId→Pane routing table, the global status bar, session
// creation, and routing of PTY events from the main process. It is the sole
// caller of window.api.pty.* — panes delegate privileged work here.
import { TerminalTab } from './terminal-tab';
import { Pane } from './pane';
import type { Tab } from './pane';
import { SettingsView } from './settings-view';
import { openCommandMenu } from './command-menu';
import { openContextMenu, type ContextMenuEntry } from './context-menu';
import { copyPathAction, revealAction } from './file-manager';
import type { LayoutMode } from './layout';
import type { SettingsStore } from './settings-store';
import type { ThemeManager } from './theme';
import { isMeaningfulTitle } from '../electron/ipc';

/** Synthetic, app-wide id for the single Settings tab (it has no PTY). */
const SETTINGS_ID = 'settings';

/** Don't surface a tab's elapsed timer until it's been busy this long — avoids a
 *  flash of "00:00" when switching tabs briefly marks a session busy. */
const ELAPSED_MIN_MS = 1500;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export interface PaneManagerOpts {
  /** Called after sessions are created/updated so the history pane refreshes. */
  onSessionsChanged: () => void | Promise<void>;
  /** Settings store — source of the launch commands and the Settings tab editor. */
  settings: SettingsStore;
  /** The active terminal tab's folder changed (null = no terminal tab active),
   *  so the folder tree can highlight the linked directory. */
  onActiveFolderChanged?: (folder: string | null) => void;
  /** Pin a tab's folder to the left pane's "Pinned" list (tab right-click menu). */
  onPinFolder?: (folder: string) => void;
}

export class PaneManager {
  private readonly panes: Pane[] = [];
  private active: Pane | null = null;
  private readonly ptyIndex = new Map<string, Pane>();
  private homeDir = '';
  // Set by app.ts so the manager can request a layout change (e.g. splitting a
  // single view into a double to relocate a tab). Keeps the title-bar highlight
  // in sync — the manager doesn't own the LayoutManager.
  private requestLayout: ((mode: LayoutMode) => void) | null = null;
  // Status-bar value spans, resolved once. Re-querying the document on every
  // status transition (which fires on PTY output) competes with keystroke
  // dispatch on the renderer's single main thread and makes typing feel laggy.
  private readonly statusEls = new Map<string, HTMLElement>();
  // The status-bar git-branch wrapper (whole segment toggles hidden), resolved once.
  private branchSeg: HTMLElement | null = null;
  // The status-bar change-count button (toggles hidden; click opens a diff tab).
  private changesSeg: HTMLButtonElement | null = null;
  // Last folder reported to onActiveFolderChanged; guards against re-notifying on
  // the hot path (status/usage/context repaints all call paintStatusBar).
  private lastNotifiedFolder: string | null = null;
  // Set by app.ts once both exist; the Settings tab's theme selector drives it.
  private themeManager: ThemeManager | null = null;

  constructor(private readonly opts: PaneManagerOpts) {}

  setHomeDir(dir: string): void {
    this.homeDir = dir;
  }

  setThemeManager(theme: ThemeManager): void {
    this.themeManager = theme;
  }

  /** Re-apply the active theme to every terminal (xterm reads colors once, so a
   *  light/dark switch needs an explicit re-theme). Called by ThemeManager. */
  applyTerminalTheme(): void {
    for (const pane of this.panes) {
      for (const tab of pane.tabList()) tab.term.applyTheme?.();
    }
  }

  /** Wire the manager to the layout controller (set once at startup). */
  setLayoutController(fn: (mode: LayoutMode) => void): void {
    this.requestLayout = fn;
  }

  getActive(): Pane | null {
    return this.active;
  }

  panesList(): readonly Pane[] {
    return this.panes;
  }

  // --- pane set (driven by LayoutManager) -------------------------------

  /** Grow or shrink to exactly `n` panes, relocating tabs when shrinking. */
  ensurePaneCount(n: number): Pane[] {
    if (n > this.panes.length) {
      while (this.panes.length < n) this.panes.push(this.createPane());
    } else if (n < this.panes.length) {
      this.shrinkTo(n);
    }
    if (!this.active || !this.panes.includes(this.active)) this.active = this.panes[0] ?? null;
    this.refreshActiveHighlight();
    return this.panes;
  }

  private shrinkTo(n: number): void {
    const survivor = this.panes[n - 1]!;
    for (let i = n; i < this.panes.length; i++) {
      const from = this.panes[i]!;
      for (const id of from.tabIds()) {
        const tab = from.releaseTab(id);
        if (!tab) continue;
        survivor.adoptTab(tab);
        this.ptyIndex.set(id, survivor);
      }
      from.dispose();
    }
    this.panes.length = n;
    // Ensure the survivor shows something if it just inherited tabs.
    if (!survivor.activeTab() && survivor.count() > 0) {
      survivor.activateTab(survivor.tabIds()[0]!);
    }
  }

  private createPane(): Pane {
    return new Pane({
      onActivated: (pane) => this.setActivePane(pane),
      onTabActivated: (pane, id) => {
        if (pane === this.active && this.active.activeTab()?.ptyId === id) this.paintStatusBar();
      },
      onNewTab: (pane, anchor) => {
        this.setActivePane(pane);
        const r = anchor.getBoundingClientRect();
        const folder = this.opts.settings.general().defaultFolder || this.homeDir;
        openCommandMenu(r.left, r.bottom, this.opts.settings.commands(), (cmd) =>
          void this.createSession(folder, { command: cmd.command }),
        );
      },
      onTabClicked: (id) => {
        const pane = this.ptyIndex.get(id);
        if (!pane) return;
        pane.activateTab(id);
        this.setActivePane(pane);
      },
      onCloseTab: (id) => this.closeTab(id),
      onTabContextMenu: (id, x, y) => this.openTabMenu(id, x, y),
      onEmpty: () => this.paintStatusBar(),
      resize: (id, cols, rows) => window.api.pty.resize(id, cols, rows),
    });
  }

  setActivePane(pane: Pane): void {
    if (this.active === pane) return;
    this.active = pane;
    this.refreshActiveHighlight();
    this.paintStatusBar();
  }

  private refreshActiveHighlight(): void {
    const multi = this.panes.length > 1;
    for (const p of this.panes) p.setActiveHighlight(multi && p === this.active);
  }

  /** Refit every pane's active terminal (after a layout/resize change). */
  refitAll(): void {
    requestAnimationFrame(() => {
      for (const p of this.panes) p.refitActive();
    });
  }

  // --- session lifecycle ------------------------------------------------

  async createSession(
    folder: string,
    opts: {
      persistentId?: string;
      claudeId?: string | null;
      command?: string;
      title?: string | null;
    } = {},
  ): Promise<void> {
    const pane = this.active;
    if (!pane) return;

    const term = new TerminalTab(pane.stackEl);
    const dims = term.fit();

    const startupCommand = opts.claudeId
      ? `claude --resume ${opts.claudeId}`
      : (opts.command ?? 'claude');
    const ptyId = await window.api.pty.spawn({
      folder,
      cols: dims.cols,
      rows: dims.rows,
      startupCommand,
    });

    term.onInput((data) => window.api.pty.write(ptyId, data));

    const tab: Tab = {
      kind: 'terminal',
      persistentId: opts.persistentId ?? ptyId,
      ptyId,
      folder,
      title: opts.title ?? null,
      status: 'idle',
      busyStart: null,
      startedAt: Date.now(),
      totalCost: 0,
      totalTokens: 0,
      context: null,
      branch: null,
      changes: 0,
      gitRoot: null,
      term,
      btn: document.createElement('button'),
      dot: document.createElement('span'),
      elapsedEl: document.createElement('span'),
    };
    this.ptyIndex.set(ptyId, pane);
    pane.addTab(tab);

    // Resolve the folder's git branch + change count for the status bar, walking
    // up to the nearest ancestor repo (best-effort, async).
    void window.api.git.info(folder, true).then((info) => {
      tab.branch = info?.branch ?? null;
      tab.changes = info?.changes ?? 0;
      tab.gitRoot = info?.root ?? null;
      if (this.isActiveTab(ptyId)) this.paintStatusBar();
    });

    // The agent CLI publishes a short task summary via the terminal title (OSC);
    // adopt it as the session's display title and persist it so it survives in the
    // history pane after the terminal is gone.
    term.onTitle((title) => {
      const t = title.trim();
      // Ignore shell-set titles (the bare exe path / cwd) — keep the folder name.
      if (!isMeaningfulTitle(t) || tab.title === t) return;
      tab.title = t;
      pane.setTitle(ptyId, t);
      void this.persistSession(tab, opts.claudeId ?? null);
    });

    const now = new Date().toISOString();
    try {
      await window.api.sessions.save({
        id: tab.persistentId,
        folder,
        claudeId: opts.claudeId ?? null,
        title: opts.title ?? null,
        createdAt: now,
        lastActive: now,
        totalTokens: 0,
        totalCost: 0,
      });
      await this.opts.onSessionsChanged();
    } catch {
      /* persistence failed — session still runs, just isn't saved */
    }
  }

  /** Re-save a session's current snapshot (folder/title/totals). Used when the
   *  title changes mid-session. Token/cost totals are owned by the session store,
   *  so we pass 0 to avoid clobbering them (it only overwrites when totals > 0). */
  private async persistSession(tab: Tab, claudeId: string | null): Promise<void> {
    try {
      await window.api.sessions.save({
        id: tab.persistentId,
        folder: tab.folder,
        claudeId,
        title: tab.title,
        createdAt: new Date().toISOString(),
        lastActive: new Date().toISOString(),
        totalTokens: 0,
        totalCost: 0,
      });
      await this.opts.onSessionsChanged();
    } catch {
      /* persistence failed */
    }
  }

  /** Open the Settings tab in the active (first available) pane, or focus it if
   *  it already exists somewhere — there is only ever one. */
  openSettings(): void {
    for (const pane of this.panes) {
      if (pane.has(SETTINGS_ID)) {
        pane.activateTab(SETTINGS_ID);
        this.setActivePane(pane);
        return;
      }
    }
    const pane = this.active ?? this.panes[0] ?? null;
    if (!pane) return;
    this.setActivePane(pane);

    const view = new SettingsView(pane.stackEl, this.opts.settings, this.themeManager);
    const tab: Tab = {
      kind: 'settings',
      persistentId: SETTINGS_ID,
      ptyId: SETTINGS_ID,
      folder: '',
      title: null,
      status: 'idle',
      busyStart: null,
      startedAt: Date.now(),
      totalCost: 0,
      totalTokens: 0,
      context: null,
      branch: null,
      changes: 0,
      gitRoot: null,
      term: view,
      btn: document.createElement('button'),
      dot: document.createElement('span'),
      elapsedEl: document.createElement('span'),
    };
    this.ptyIndex.set(SETTINGS_ID, pane);
    pane.addTab(tab);
  }

  private closeTab(ptyId: string): void {
    const pane = this.ptyIndex.get(ptyId);
    if (!pane) return;
    // The Settings tab has no backing PTY — don't try to kill one.
    if (pane.get(ptyId)?.kind === 'terminal') window.api.pty.kill(ptyId);
    this.ptyIndex.delete(ptyId);
    pane.removeTab(ptyId);
    this.paintStatusBar();
  }

  // --- tab context menu / relocation ------------------------------------

  /** Right-click on a tab: offer to move it to a neighbouring pane (only the
   *  directions that have one, given the current layout) and to close it. */
  private openTabMenu(ptyId: string, x: number, y: number): void {
    const pane = this.ptyIndex.get(ptyId);
    if (!pane || !pane.has(ptyId)) return;

    const entries: ContextMenuEntry[] = [];

    // Terminal tabs are tied to a folder — offer to open it in the file manager
    // and to copy its path; both sit at the top of the menu.
    const tab = pane.get(ptyId);
    if (tab?.kind === 'terminal' && tab.folder) {
      const folder = tab.folder;
      entries.push(revealAction(folder), copyPathAction(folder));
      if (this.opts.onPinFolder) {
        entries.push({ icon: 'lucide:pin', label: 'Pin folder', onSelect: () => this.opts.onPinFolder!(folder) });
      }
      entries.push('separator');
    }

    if (this.panes.length === 1 && this.requestLayout) {
      // Single view: there's no neighbour to move into yet — offer to split into
      // a double view, relocating this tab into the new group on the right.
      entries.push({
        icon: 'lucide:arrow-right',
        label: 'Move to new tab group right',
        onSelect: () => this.moveToNewGroupRight(ptyId),
      });
    } else {
      for (const m of this.paneNeighbors(this.panes.indexOf(pane))) {
        entries.push({ icon: m.icon, label: m.label, onSelect: () => this.moveTab(ptyId, m.target) });
      }
    }
    // Close always sits last; only separate it when moves precede it.
    if (entries.length) entries.push('separator');
    entries.push({
      icon: 'lucide:x',
      label: 'Close',
      danger: true,
      onSelect: () => this.closeTab(ptyId),
    });

    openContextMenu(x, y, entries);
  }

  /** The pane indices reachable from `index` by one step in each direction,
   *  derived from the implicit grid of the current pane count (1 / 2×2 / 3×2). */
  private paneNeighbors(
    index: number,
  ): { icon: string; label: string; target: number }[] {
    const count = this.panes.length;
    const cols = count === 6 ? 3 : count >= 2 ? 2 : 1;
    const rows = Math.max(1, Math.floor(count / cols));
    const row = Math.floor(index / cols);
    const col = index % cols;
    const out: { icon: string; label: string; target: number }[] = [];
    if (col > 0) out.push({ icon: 'lucide:arrow-left', label: 'Move left', target: index - 1 });
    if (col < cols - 1) out.push({ icon: 'lucide:arrow-right', label: 'Move right', target: index + 1 });
    if (row > 0) out.push({ icon: 'lucide:arrow-up', label: 'Move up', target: index - cols });
    if (row < rows - 1) out.push({ icon: 'lucide:arrow-down', label: 'Move down', target: index + cols });
    return out;
  }

  /** Relocate a tab to another pane without disposing its terminal, mirroring
   *  the shrink path: release → adopt → re-point the ptyIndex → re-activate. */
  private moveTab(ptyId: string, targetIndex: number): void {
    const from = this.ptyIndex.get(ptyId);
    const to = this.panes[targetIndex];
    if (!from || !to || from === to) return;

    const tab = from.releaseTab(ptyId);
    if (!tab) return;
    to.adoptTab(tab);
    this.ptyIndex.set(ptyId, to);
    to.activateTab(ptyId);

    // releaseTab leaves the source with no active tab — surface its next one (or
    // let it sit empty, which is fine in a multi-pane layout).
    if (!from.activeTab() && from.count() > 0) from.activateTab(from.tabIds()[0]!);

    this.setActivePane(to);
  }

  /** Split a single view into a double, moving the tab into the new right pane. */
  private moveToNewGroupRight(ptyId: string): void {
    if (!this.requestLayout) return;
    this.requestLayout('double'); // grows the pane set to 2 (right pane is index 1)
    this.moveTab(ptyId, 1);
  }

  // --- PTY event routing ------------------------------------------------

  routeData(id: string, data: string): void {
    this.ptyIndex.get(id)?.get(id)?.term.feed?.(data);
  }

  routeStatus(id: string, status: Tab['status']): void {
    const pane = this.ptyIndex.get(id);
    const tab = pane?.get(id);
    if (!pane || !tab) return;
    tab.status = status;
    if (status === 'busy' && !tab.busyStart) tab.busyStart = Date.now();
    if (status !== 'busy') tab.busyStart = null;
    pane.paintStatus(tab);
    if (this.isActiveTab(id)) this.paintStatusBar();
  }

  routeUsage(id: string, tokensIn: number, tokensOut: number): void {
    const pane = this.ptyIndex.get(id);
    const tab = pane?.get(id);
    if (!pane || !tab) return;
    void (async () => {
      try {
        const updated = await window.api.usage.add(tab.persistentId, tokensIn, tokensOut);
        tab.totalCost = updated.totalCost;
        tab.totalTokens = updated.totalTokens;
        if (this.isActiveTab(id)) this.paintStatusBar();
        await this.opts.onSessionsChanged();
      } catch {
        /* persistence failed */
      }
    })();
  }

  routeExit(id: string): void {
    const pane = this.ptyIndex.get(id);
    const tab = pane?.get(id);
    if (pane && tab) {
      tab.status = 'done';
      pane.paintStatus(tab);
    }
  }

  // --- status bar -------------------------------------------------------

  private isActiveTab(id: string): boolean {
    return this.active?.activeTab()?.ptyId === id;
  }

  private statusValue(id: string): HTMLElement {
    let el = this.statusEls.get(id);
    if (!el) {
      el = $(`#${id}`).querySelector('span:last-child') as HTMLElement;
      this.statusEls.set(id, el);
    }
    return el;
  }

  /** Write text only if it changed — avoids redundant layout/paint on the hot path. */
  private setText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) el.textContent = text;
  }

  paintStatusBar(): void {
    // The status bar describes a terminal session; a non-terminal view (Settings)
    // shows the neutral placeholders.
    const active = this.active?.activeTab() ?? null;
    const tab = active && active.kind === 'terminal' ? active : null;
    this.notifyActiveFolder(tab ? tab.folder : null);
    this.setText(this.statusValue('status-folder'), tab ? tab.folder : '—');
    this.paintBranchStatus(tab);
    this.paintChangesStatus(tab);
    this.paintContextStatus(tab);
    this.setText(
      this.statusValue('status-elapsed'),
      tab && tab.busyStart ? fmtElapsed(Date.now() - tab.busyStart) : '—',
    );
  }

  /** Tell the folder tree which directory the active session lives in — but only
   *  when it actually changed, since paintStatusBar runs on every PTY repaint. */
  private notifyActiveFolder(folder: string | null): void {
    if (folder === this.lastNotifiedFolder) return;
    this.lastNotifiedFolder = folder;
    this.opts.onActiveFolderChanged?.(folder);
  }

  /** Poll each terminal tab's context-window occupancy from its transcript and
   *  repaint its gauge. Called on a slow interval (reads are cheap tail reads). */
  async refreshContext(): Promise<void> {
    for (const pane of this.panes) {
      for (const tab of pane.tabList()) {
        if (tab.kind !== 'terminal') continue;
        try {
          // Pass startedAt so a transcript left over from a prior run in the same
          // folder is ignored — only this session's own activity drives the gauge.
          tab.context = await window.api.context.get(tab.folder, tab.startedAt);
        } catch {
          tab.context = null;
        }
        // Re-read the branch + change count too, so a checkout or edits in the
        // terminal are reflected.
        try {
          const info = await window.api.git.info(tab.folder, true);
          tab.branch = info?.branch ?? null;
          tab.changes = info?.changes ?? 0;
          tab.gitRoot = info?.root ?? null;
        } catch {
          tab.branch = null;
          tab.changes = 0;
          tab.gitRoot = null;
        }
        pane.paintContext(tab);
      }
    }
    this.paintStatusBar();
  }

  /** Status-bar git-branch segment for the active tab; hidden when the folder
   *  isn't a repo (so it never shows a bare dash). */
  private paintBranchStatus(tab: Tab | null): void {
    this.branchSeg ??= $('#status-branch');
    const branch = tab?.branch ?? null;
    this.branchSeg.hidden = !branch;
    if (branch) this.setText(this.statusValue('status-branch'), branch);
  }

  /** Status-bar working-tree change count for the active tab: a clickable badge
   *  (hidden when clean / not a repo) that opens a diff in a new tab. */
  private paintChangesStatus(tab: Tab | null): void {
    if (!this.changesSeg) {
      this.changesSeg = $<HTMLButtonElement>('#status-changes');
      // Wire the click once; it reads the live active tab at click time so the
      // diff always targets whatever session is in focus.
      this.changesSeg.addEventListener('click', () => this.openDiffForActive());
    }
    const seg = this.changesSeg;
    const changes = tab?.branch ? tab.changes : 0;
    seg.hidden = changes <= 0;
    if (changes > 0) {
      this.setText(this.statusValue('status-changes'), String(changes));
      seg.title = `${changes} working-tree change${changes === 1 ? '' : 's'} — click to view the diff`;
    }
  }

  /** Open the active session's working-tree diff in a fresh tab (paged `git diff`),
   *  rooted at the repo. No-op when the active tab isn't a repo. */
  private openDiffForActive(): void {
    const tab = this.active?.activeTab() ?? null;
    if (!tab || tab.kind !== 'terminal' || !tab.branch) return;
    const cwd = tab.gitRoot ?? tab.folder;
    void this.createSession(cwd, {
      command: 'git diff HEAD',
      title: `diff: ${tab.branch}`,
    });
  }

  /** Status-bar context segment for the active tab: "63%", tinted at the thresholds. */
  private paintContextStatus(tab: Tab | null): void {
    const el = this.statusValue('status-context');
    const c = tab?.context ?? null;
    if (!c || c.limit <= 0 || c.tokens <= 0) {
      this.setText(el, '—');
      el.style.color = '';
      return;
    }
    const pct = Math.round(Math.min(100, (c.tokens / c.limit) * 100));
    this.setText(el, `${pct}%`);
    el.style.color =
      pct >= 95 ? 'var(--color-danger)' : pct >= 80 ? 'var(--color-warn)' : '';
  }

  /** Tick elapsed timers across all panes (called on an interval). */
  tickElapsed(): void {
    for (const pane of this.panes) {
      for (const tab of pane.tabList()) {
        const ms = tab.busyStart ? Date.now() - tab.busyStart : 0;
        this.setText(tab.elapsedEl, ms >= ELAPSED_MIN_MS ? fmtElapsed(ms) : '');
      }
    }
    const active = this.active?.activeTab();
    this.setText(
      this.statusValue('status-elapsed'),
      active && active.busyStart ? fmtElapsed(Date.now() - active.busyStart) : '—',
    );
  }
}
