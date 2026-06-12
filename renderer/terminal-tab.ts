// Thin wrapper around an xterm.js terminal for one session. Handles addon wiring
// (fit, web-links, WebGL renderer) and exposes a minimal surface the app uses to
// pump bytes to/from the main-process PTY.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

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
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#f78166',
        selectionBackground: '#264f78',
      },
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
  }

  onInput(cb: (data: string) => void): void {
    this.term.onData(cb);
  }

  /**
   * Fires when the program sets the terminal title via an OSC sequence
   * (`\x1b]0;…\x07` / `\x1b]2;…`). Claude Code uses this to publish a short
   * summary of the current task; we surface it as the session's display title.
   */
  onTitle(cb: (title: string) => void): void {
    this.term.onTitleChange(cb);
  }

  feed(data: string): void {
    this.term.write(data);
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
