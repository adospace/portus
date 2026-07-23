// Thin wrapper around an xterm.js terminal for one session. Handles addon wiring
// (fit, web-links, WebGL renderer) and exposes a minimal surface the app uses to
// pump bytes to/from the main-process PTY.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

/** Read the current theme colors from the CSS custom properties so the terminal
 *  tracks light/dark. xterm can't resolve `var(...)` itself (it renders to a
 *  canvas/WebGL surface), so we resolve them here and hand it concrete hexes. */
function readTerminalTheme(): ITheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string =>
    s.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--color-term-bg', '#0d1117'),
    foreground: v('--color-fg', '#e6edf3'),
    cursor: v('--color-accent', '#f78166'),
    selectionBackground: v('--color-selection', '#264f78'),
  };
}

export class TerminalTab {
  readonly host: HTMLDivElement;
  private readonly term: Terminal;
  private readonly fitAddon = new FitAddon();

  constructor(parent: HTMLElement) {
    this.host = document.createElement('div');
    this.host.className = 'term-host';
    parent.appendChild(this.host);

    // xterm renders to canvas/WebGL and cannot resolve CSS `var(...)` in its font
    // string — pass the concrete stack from our theme token instead.
    const mono =
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      '"Cascadia Code", "JetBrains Mono", Consolas, monospace';

    this.term = new Terminal({
      fontFamily: mono,
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      // Agent CLIs assume a dark terminal and emit near-white / faint colors for
      // code-block and diff-context text, which is unreadable on the light theme's
      // pale background. xterm recolors any cell whose foreground/background pair
      // falls below this ratio (computed against the cell's *actual* bg, so red/
      // green diff rows are handled too), pulling that text dark enough to read.
      // Applied in both themes — it only touches colors that fail the threshold.
      minimumContrastRatio: 4.5,
      theme: readTerminalTheme(),
    });

    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());
    this.term.open(this.host);

    // WebGL is the fast path but can fail on some GPUs/drivers — fall back to the
    // default renderer rather than crashing the tab.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      console.warn('[term] WebGL renderer unavailable, using canvas fallback');
    }

    this.wireClipboard();
  }

  /**
   * Explicit clipboard handling. xterm's default relies on the browser's native
   * paste, which Electron gates behind a permission (and a competing default-menu
   * paste accelerator), so pastes into the agent prompt silently fail. We drive it
   * ourselves through Electron's clipboard (exposed on `window.api.clipboard`):
   *   • Ctrl/Cmd+V (and Ctrl+Shift+V) → paste, honouring bracketed-paste mode.
   *   • Ctrl/Cmd+C → copy the current selection if there is one; otherwise fall
   *     through so the terminal still receives it as SIGINT (classic behaviour).
   *   • Ctrl/Cmd+Shift+C → copy the current selection (when there is one).
   *   • Right-click → copy the selection if any, else paste (classic terminal).
   */
  private wireClipboard(): void {
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = window.api.platform === 'darwin' ? e.metaKey : e.ctrlKey;
      if (!mod) return true;

      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        this.paste();
        return false;
      }
      if (e.key === 'c' || e.key === 'C') {
        // Copy when there's a selection (Ctrl/Cmd+C *or* +Shift+C). With no
        // selection, plain Ctrl/Cmd+C must pass through so the agent still gets
        // SIGINT; only Shift+C is swallowed (it's never an interrupt chord).
        if (this.copySelection()) {
          this.term.clearSelection();
          e.preventDefault();
          return false;
        }
        return !e.shiftKey;
      }
      return true;
    });

    this.host.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.copySelection()) this.paste();
      else this.term.clearSelection();
    });
  }

  /** Write the clipboard text into the terminal (respects bracketed-paste mode). */
  private paste(): void {
    const text = window.api.clipboard.readText();
    if (text) this.term.paste(text);
  }

  /** Copy the current selection to the clipboard; returns false if nothing selected. */
  private copySelection(): boolean {
    const sel = this.term.getSelection();
    if (!sel) return false;
    window.api.clipboard.writeText(sel);
    return true;
  }

  onInput(cb: (data: string) => void): void {
    // xterm reports focus changes (CSI I / CSI O, each as its own data event)
    // to apps that enable DECSET 1004. In a tab UI those reports are poison:
    // switching tabs blurs the deselected terminal, and Claude Code freezes its
    // title animation — the tab's whole liveness signal — the moment it hears
    // focus-out. Drop the real reports; pty-manager.ts answers the mode-enable
    // with a synthetic focus-in, so every agent runs believing it's focused.
    this.term.onData((data) => {
      if (data === '\x1b[I' || data === '\x1b[O') return;
      cb(data);
    });
  }

  // The window title (OSC 0/2) is not read here: xterm only parses it once the
  // written bytes work their way through its buffer, which is scheduled work in
  // the renderer and therefore hostage to whatever else the UI is doing. The
  // main process parses it straight off the PTY stream instead (pty-manager.ts),
  // so a background tab's label keeps pace with its agent.

  feed(data: string): void {
    this.term.write(data);
  }

  /** Re-read the CSS theme colors and apply them (called when the scheme flips). */
  applyTheme(): void {
    this.term.options.theme = readTerminalTheme();
  }

  /** Refit to the host size and report the new dimensions. */
  fit(): { cols: number; rows: number } {
    try {
      this.fitAddon.fit();
    } catch {
      /* host not laid out yet */
    }
    return { cols: this.term.cols, rows: this.term.rows };
  }

  /**
   * Move this terminal's host element into a new parent. xterm keeps its
   * canvas/WebGL state across the DOM move as long as `dispose()` isn't called;
   * the caller must `fit()` + resize the PTY afterward since the new container's
   * size may differ. Used when relocating tabs between panes on layout change.
   */
  reparent(parent: HTMLElement): void {
    parent.appendChild(this.host);
  }

  show(): void {
    this.host.hidden = false;
    this.fit();
    this.term.focus();
  }

  hide(): void {
    this.host.hidden = true;
  }

  dispose(): void {
    this.term.dispose();
    this.host.remove();
  }
}
