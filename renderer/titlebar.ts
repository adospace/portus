// Custom window chrome (VS Code-style). Owns the title bar's interactive bits:
// the File ▸ Exit menu, the single/quad/six layout selector, and the
// minimize/maximize/close window controls. macOS keeps its native traffic
// lights, so the custom window controls are hidden there and the bar is padded
// to clear the inset buttons.
import type { LayoutMode } from './layout';

// Render an icon into a stable wrapper via the <iconify-icon> web component, so
// the listener on the wrapper survives icon swaps (e.g. the max/restore glyph).
function setIcon(wrapper: HTMLElement, icon: string): void {
  wrapper.innerHTML = `<iconify-icon icon="${icon}"></iconify-icon>`;
}

export class TitleBar {
  private menu: HTMLElement | null = null;
  private readonly layoutBtns: HTMLButtonElement[];

  constructor(
    private readonly onLayoutChange: (mode: LayoutMode) => void,
    private readonly onOpenSettings: () => void,
  ) {
    const isMac = window.api.platform === 'darwin';

    // Window controls — Windows/Linux only; macOS uses native traffic lights.
    const winControls = document.getElementById('win-controls');
    if (isMac) {
      winControls?.remove();
      // Clear the inset traffic lights on the left.
      const left = document.getElementById('titlebar-left');
      if (left) left.style.paddingLeft = '78px';
    } else {
      document.getElementById('win-min')?.addEventListener('click', () => window.api.win.minimize());
      const maxBtn = document.getElementById('win-max');
      maxBtn?.addEventListener('click', () => window.api.win.maximizeToggle());
      document.getElementById('win-close')?.addEventListener('click', () => window.api.win.close());

      // Keep the max/restore glyph in sync with the real window state.
      const paintMax = (maximized: boolean): void => {
        if (maxBtn) setIcon(maxBtn, maximized ? 'lucide:copy' : 'lucide:square');
      };
      window.api.win.onMaximizedChanged(paintMax);
      void window.api.win.isMaximized().then(paintMax);
    }

    // Gear button → Settings tab.
    document
      .getElementById('open-settings')
      ?.addEventListener('click', () => this.onOpenSettings());

    // File menu.
    const fileBtn = document.getElementById('menu-file');
    fileBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = fileBtn.getBoundingClientRect();
      this.toggleFileMenu(r.left, r.bottom);
    });
    document.addEventListener('click', () => this.closeMenu());

    // Layout selector.
    this.layoutBtns = [...document.querySelectorAll<HTMLButtonElement>('#layout-select .layout-btn')];
    for (const btn of this.layoutBtns) {
      btn.addEventListener('click', () => {
        const mode = btn.dataset['mode'] as LayoutMode;
        this.setActive(mode);
        this.onLayoutChange(mode);
      });
    }
    this.setActive('single');
  }

  /** Highlight the layout button matching the active mode. */
  setActive(mode: LayoutMode): void {
    for (const btn of this.layoutBtns) {
      const on = btn.dataset['mode'] === mode;
      btn.classList.toggle('bg-edge', on);
      btn.classList.toggle('text-fg', on);
      btn.classList.toggle('text-muted', !on);
    }
  }

  private toggleFileMenu(x: number, y: number): void {
    if (this.menu) {
      this.closeMenu();
      return;
    }
    const menu = document.createElement('div');
    menu.className =
      'fixed z-50 min-w-40 rounded-md border border-edge bg-panel py-1 shadow-lg text-sm';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.addEventListener('click', (e) => e.stopPropagation());

    const settings = document.createElement('button');
    settings.className = 'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-edge/60';
    settings.innerHTML =
      '<iconify-icon icon="lucide:settings"></iconify-icon><span>Settings</span>';
    settings.addEventListener('click', () => {
      this.closeMenu();
      this.onOpenSettings();
    });

    const sep = document.createElement('div');
    sep.className = 'my-1 border-t border-edge';

    const exit = document.createElement('button');
    exit.className = 'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-edge/60';
    exit.innerHTML =
      '<iconify-icon icon="lucide:log-out"></iconify-icon><span>Exit</span>';
    exit.addEventListener('click', () => {
      this.closeMenu();
      window.api.app.quit();
    });

    menu.append(settings, sep, exit);
    document.body.appendChild(menu);
    this.menu = menu;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}
