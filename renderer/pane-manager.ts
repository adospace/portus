// Orchestrates the set of panes: owns the ordered Pane[], the single globally
// active pane, the ptyId→Pane routing table, the global status bar, session
// creation, and routing of PTY events from the main process. It is the sole
// caller of window.api.pty.* — panes delegate privileged work here.
import { TerminalTab } from './terminal-tab';
import { Pane } from './pane';
import type { Tab } from './pane';
import { SettingsView } from './settings-view';
import { openCommandMenu } from './command-menu';
import type { SettingsStore } from './settings-store';

/** Synthetic, app-wide id for the single Settings tab (it has no PTY). */
const SETTINGS_ID = 'settings';

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
}

export class PaneManager {
  private readonly panes: Pane[] = [];
  private active: Pane | null = null;
  private readonly ptyIndex = new Map<string, Pane>();
  private homeDir = '';
  // Status-bar value spans, resolved once. Re-querying the document on every
  // status transition (which fires on PTY output) competes with keystroke
  // dispatch on the renderer's single main thread and makes typing feel laggy.
  private readonly statusEls = new Map<string, HTMLElement>();

  constructor(private readonly opts: PaneManagerOpts) {}

  setHomeDir(dir: string): void {
    this.homeDir = dir;
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
        openCommandMenu(r.left, r.bottom, this.opts.settings.commands(), (cmd) =>
          void this.createSession(this.homeDir, { command: cmd.command }),
        );
      },
      onTabClicked: (id) => {
        const pane = this.ptyIndex.get(id);
        if (!pane) return;
        pane.activateTab(id);
        this.setActivePane(pane);
      },
      onCloseTab: (id) => this.closeTab(id),
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
    opts: { persistentId?: string; claudeId?: string | null; command?: string } = {},
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
      status: 'idle',
      busyStart: null,
      totalCost: 0,
      totalTokens: 0,
      term,
      btn: document.createElement('button'),
      dot: document.createElement('span'),
      elapsedEl: document.createElement('span'),
    };
    this.ptyIndex.set(ptyId, pane);
    pane.addTab(tab);

    const now = new Date().toISOString();
    try {
      await window.api.sessions.save({
        id: tab.persistentId,
        folder,
        claudeId: opts.claudeId ?? null,
        createdAt: now,
        lastActive: now,
        totalTokens: 0,
        totalCost: 0,
      });
      await this.opts.onSessionsChanged();
    } catch {
      /* sidecar offline — session still runs, just isn't persisted */
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

    const view = new SettingsView(pane.stackEl, this.opts.settings);
    const tab: Tab = {
      kind: 'settings',
      persistentId: SETTINGS_ID,
      ptyId: SETTINGS_ID,
      folder: '',
      status: 'idle',
      busyStart: null,
      totalCost: 0,
      totalTokens: 0,
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
        /* sidecar offline */
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
    this.setText(this.statusValue('status-folder'), tab ? tab.folder : '—');
    this.setText(this.statusValue('status-cost'), tab ? tab.totalCost.toFixed(4) : '0.0000');
    this.setText(this.statusValue('status-model'), tab ? 'claude' : '—');
    this.setText(
      this.statusValue('status-elapsed'),
      tab && tab.busyStart ? fmtElapsed(Date.now() - tab.busyStart) : '—',
    );
  }

  /** Tick elapsed timers across all panes (called on an interval). */
  tickElapsed(): void {
    for (const pane of this.panes) {
      for (const tab of pane.tabList()) {
        this.setText(tab.elapsedEl, tab.busyStart ? fmtElapsed(Date.now() - tab.busyStart) : '');
      }
    }
    const active = this.active?.activeTab();
    this.setText(
      this.statusValue('status-elapsed'),
      active && active.busyStart ? fmtElapsed(Date.now() - active.busyStart) : '—',
    );
  }
}
