// A reusable drag-to-resize gutter. Used for both the outer 3-pane columns and
// the inner gutters of the quad/six layouts. The gutter doesn't know about grid
// tracks directly — the caller supplies get/set closures that read and write the
// CSS custom property backing the controlled track, plus a dynamic min/max.
export type SplitterAxis = 'col' | 'row';

export interface SplitterOpts {
  /** The draggable gutter element. */
  gutter: HTMLElement;
  axis: SplitterAxis;
  /** Current size (px) of the controlled track. */
  get: () => number;
  /** Write a new size (px) for the controlled track. */
  set: (px: number) => void;
  /** Lower bound (px). */
  min: number;
  /** Upper bound (px), evaluated lazily so it can track container size. */
  max: () => number;
  /**
   * Drag direction. +1 (default) when the controlled track is before the
   * gutter (moving the gutter away grows it); -1 when it sits after the gutter
   * (e.g. the right side pane), so a rightward drag shrinks it.
   */
  sign?: 1 | -1;
  /** Called (rAF-coalesced) as the size changes — refit terminals here. */
  onResize?: () => void;
  /** Called once when a drag ends — persist here if needed. */
  onCommit?: () => void;
}

export class Splitter {
  private startCoord = 0;
  private startSize = 0;
  private raf = 0;

  constructor(private readonly opts: SplitterOpts) {
    opts.gutter.addEventListener('pointerdown', this.onDown);
  }

  private readonly onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.startCoord = this.opts.axis === 'col' ? e.clientX : e.clientY;
    this.startSize = this.opts.get();
    this.opts.gutter.setPointerCapture(e.pointerId);
    this.opts.gutter.addEventListener('pointermove', this.onMove);
    this.opts.gutter.addEventListener('pointerup', this.onUp);
    document.body.classList.add('resizing');
  };

  private readonly onMove = (e: PointerEvent): void => {
    const coord = this.opts.axis === 'col' ? e.clientX : e.clientY;
    const sign = this.opts.sign ?? 1;
    const next = this.startSize + sign * (coord - this.startCoord);
    const clamped = Math.max(this.opts.min, Math.min(next, this.opts.max()));
    this.opts.set(clamped);
    if (this.opts.onResize && this.raf === 0) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.opts.onResize?.();
      });
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    this.opts.gutter.releasePointerCapture(e.pointerId);
    this.opts.gutter.removeEventListener('pointermove', this.onMove);
    this.opts.gutter.removeEventListener('pointerup', this.onUp);
    document.body.classList.remove('resizing');
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.opts.onResize?.();
    this.opts.onCommit?.();
  };

  dispose(): void {
    this.opts.gutter.removeEventListener('pointerdown', this.onDown);
  }
}
