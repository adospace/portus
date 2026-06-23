// A file-editor tab's content: a Monaco editor hosted inside a Pane's stack just
// like a TerminalTab (it implements the same show/hide/reparent/fit/dispose
// surface), so the pane relocates it across layout changes like any other tab.
// There is no PTY and no session behind it — it only reads and writes a file.
//
// Highlight-only: the full language set is bundled for syntax highlighting, but
// only the generic editor web worker is shipped (no per-language IntelliSense /
// type-checking workers), which keeps the bundle small.
import * as monaco from 'monaco-editor';

// Monaco spins up a web worker for editor services; point it at the single
// generic worker esbuild emits next to app.js. A real Worker (not the default
// blob shim) keeps us within the renderer's `worker-src 'self'` CSP.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new Worker('./editor.worker.js'),
};

/** Map the app's resolved scheme (`<html data-theme>`) to a Monaco built-in theme. */
function monacoTheme(): 'vs' | 'vs-dark' {
  return document.documentElement.dataset['theme'] === 'light' ? 'vs' : 'vs-dark';
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export class EditorView {
  readonly host: HTMLDivElement;
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly model: monaco.editor.ITextModel;
  /** Alternative-version id of the last saved state; dirty == it no longer matches.
   *  Using Monaco's version id (not a string compare) makes undo-to-saved clean. */
  private savedVersionId: number;
  private dirty = false;
  private onDirty: ((dirty: boolean) => void) | null = null;

  constructor(
    parent: HTMLElement,
    readonly path: string,
    content: string,
  ) {
    this.host = document.createElement('div');
    this.host.className = 'absolute inset-0';
    parent.appendChild(this.host);

    // A file Uri lets Monaco auto-detect the language (and thus the highlighter)
    // from the extension. Reuse an existing model for the same path if one lingers.
    const uri = monaco.Uri.file(path);
    this.model =
      monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, undefined, uri);
    if (this.model.getValue() !== content) this.model.setValue(content);

    this.editor = monaco.editor.create(this.host, {
      model: this.model,
      theme: monacoTheme(),
      automaticLayout: false, // we drive layout() from the pane's fit() path
      readOnly: false,
      fontSize: 13,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
    });

    this.savedVersionId = this.model.getAlternativeVersionId();
    this.model.onDidChangeContent(() => this.recomputeDirty());

    // Ctrl/Cmd+S saves.
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.save());
  }

  /** Notify the owner (tab UI) whenever the dirty flag flips. */
  onDirtyChange(cb: (dirty: boolean) => void): void {
    this.onDirty = cb;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /** File name (for the tab label and the close prompt). */
  name(): string {
    return baseName(this.path);
  }

  private recomputeDirty(): void {
    const next = this.model.getAlternativeVersionId() !== this.savedVersionId;
    if (next === this.dirty) return;
    this.dirty = next;
    this.onDirty?.(next);
  }

  /** Persist the buffer to disk and reset the dirty baseline. */
  async save(): Promise<void> {
    if (this.model.isDisposed()) return;
    await window.api.fs.writeFile(this.path, this.model.getValue());
    this.savedVersionId = this.model.getAlternativeVersionId();
    this.recomputeDirty();
  }

  // --- TabContent surface (mirrors TerminalTab) -------------------------

  show(): void {
    this.host.hidden = false;
    this.editor.layout();
    this.editor.focus();
  }

  hide(): void {
    this.host.hidden = true;
  }

  reparent(parent: HTMLElement): void {
    parent.appendChild(this.host);
  }

  /** Relayout to the host's current size; returns dummy dims (no PTY to resize). */
  fit(): { cols: number; rows: number } {
    this.editor.layout();
    return { cols: 0, rows: 0 };
  }

  /** Re-read the resolved scheme and switch Monaco's theme (called on a flip). */
  applyTheme(): void {
    monaco.editor.setTheme(monacoTheme());
  }

  dispose(): void {
    this.editor.dispose();
    this.model.dispose();
    this.host.remove();
  }
}
