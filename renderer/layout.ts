// Arranges the center area into single / quad (2×2) / six (3×2) layouts. Owns
// the #layout-grid DOM: builds pane slots and draggable gutters per mode, wires
// a reusable Splitter to each gutter, and drives the PaneManager to grow/shrink
// the pane set (relocating tabs when shrinking). Layout state is in-memory only
// — the app always boots in single view.
import { Splitter, type SplitterAxis } from './splitter';
import { Pane } from './pane';
import { PaneManager } from './pane-manager';

export type LayoutMode = 'single' | 'double' | 'quad' | 'six';

const PANE_COUNT: Record<LayoutMode, number> = { single: 1, double: 2, quad: 4, six: 6 };
const GUTTER = '5px';
const MIN_TRACK = 140;

export class LayoutManager {
  private mode: LayoutMode = 'single';
  private splitters: Splitter[] = [];

  constructor(
    private readonly gridEl: HTMLElement,
    private readonly mgr: PaneManager,
  ) {
    this.setMode('single');
  }

  getMode(): LayoutMode {
    return this.mode;
  }

  setMode(mode: LayoutMode): void {
    const panes = this.mgr.ensurePaneCount(PANE_COUNT[mode]);
    this.mode = mode;
    this.build(mode, panes);
    this.mgr.refitAll();
  }

  // --- grid construction ------------------------------------------------

  private build(mode: LayoutMode, panes: Pane[]): void {
    for (const s of this.splitters) s.dispose();
    this.splitters = [];
    // Detach pane roots first so replaceChildren doesn't drop them.
    for (const p of panes) p.root.remove();
    this.gridEl.replaceChildren();

    if (mode === 'single') return this.buildSingle(panes);
    if (mode === 'double') return this.buildDouble(panes);
    if (mode === 'quad') return this.buildQuad(panes);
    return this.buildSix(panes);
  }

  private buildSingle(panes: Pane[]): void {
    this.gridEl.style.gridTemplateColumns = '1fr';
    this.gridEl.style.gridTemplateRows = '1fr';
    this.gridEl.appendChild(this.slot(panes[0]!, '1', '1'));
  }

  private buildDouble(panes: Pane[]): void {
    this.gridEl.style.gridTemplateColumns =
      `minmax(0, var(--double-col, 1fr)) ${GUTTER} minmax(0, 1fr)`;
    this.gridEl.style.gridTemplateRows = '1fr';

    const s0 = this.slot(panes[0]!, '1', '1');
    const s1 = this.slot(panes[1]!, '3', '1');
    const gCol = this.gutter('col', '2', '1 / -1', 20);
    this.gridEl.append(s0, s1, gCol);

    this.addSplitter(gCol, 'col', () => s0.offsetWidth, '--double-col', 1);
  }

  private buildQuad(panes: Pane[]): void {
    this.gridEl.style.gridTemplateColumns =
      `minmax(0, var(--quad-col, 1fr)) ${GUTTER} minmax(0, 1fr)`;
    this.gridEl.style.gridTemplateRows =
      `minmax(0, var(--quad-row, 1fr)) ${GUTTER} minmax(0, 1fr)`;

    const s0 = this.slot(panes[0]!, '1', '1');
    const s1 = this.slot(panes[1]!, '3', '1');
    const s2 = this.slot(panes[2]!, '1', '3');
    const s3 = this.slot(panes[3]!, '3', '3');
    const gCol = this.gutter('col', '2', '1 / -1', 20);
    const gRow = this.gutter('row', '1 / -1', '2', 10);
    this.gridEl.append(s0, s1, s2, s3, gCol, gRow);

    this.addSplitter(gCol, 'col', () => s0.offsetWidth, '--quad-col', 1);
    this.addSplitter(gRow, 'row', () => s0.offsetHeight, '--quad-row', 1);
  }

  private buildSix(panes: Pane[]): void {
    this.gridEl.style.gridTemplateColumns =
      `minmax(0, var(--six-col-1, 1fr)) ${GUTTER} minmax(0, var(--six-col-2, 1fr)) ${GUTTER} minmax(0, 1fr)`;
    this.gridEl.style.gridTemplateRows =
      `minmax(0, var(--six-row, 1fr)) ${GUTTER} minmax(0, 1fr)`;

    const s0 = this.slot(panes[0]!, '1', '1');
    const s1 = this.slot(panes[1]!, '3', '1');
    const s2 = this.slot(panes[2]!, '5', '1');
    const s3 = this.slot(panes[3]!, '1', '3');
    const s4 = this.slot(panes[4]!, '3', '3');
    const s5 = this.slot(panes[5]!, '5', '3');
    const gColA = this.gutter('col', '2', '1 / -1', 20);
    const gColB = this.gutter('col', '4', '1 / -1', 20);
    const gRow = this.gutter('row', '1 / -1', '2', 10);
    this.gridEl.append(s0, s1, s2, s3, s4, s5, gColA, gColB, gRow);

    this.addSplitter(gColA, 'col', () => s0.offsetWidth, '--six-col-1', 2);
    this.addSplitter(gColB, 'col', () => s1.offsetWidth, '--six-col-2', 2);
    this.addSplitter(gRow, 'row', () => s0.offsetHeight, '--six-row', 1);
  }

  // --- helpers ----------------------------------------------------------

  private slot(pane: Pane, col: string, row: string): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'pane-slot';
    slot.style.gridColumn = col;
    slot.style.gridRow = row;
    slot.appendChild(pane.root);
    return slot;
  }

  private gutter(axis: SplitterAxis, col: string, row: string, z: number): HTMLElement {
    const g = document.createElement('div');
    g.className = axis === 'col' ? 'gutter-col' : 'gutter-row';
    g.style.gridColumn = col;
    g.style.gridRow = row;
    g.style.zIndex = String(z);
    return g;
  }

  /**
   * Wire a gutter to resize the track backed by `varName`. `reserve` is the
   * number of sibling tracks the drag must leave room for (clamps the max).
   */
  private addSplitter(
    gutter: HTMLElement,
    axis: SplitterAxis,
    get: () => number,
    varName: string,
    reserve: number,
  ): void {
    this.splitters.push(
      new Splitter({
        gutter,
        axis,
        get,
        set: (px) => this.gridEl.style.setProperty(varName, `${px}px`),
        min: MIN_TRACK,
        max: () => {
          const extent = axis === 'col' ? this.gridEl.clientWidth : this.gridEl.clientHeight;
          return Math.max(MIN_TRACK, extent - MIN_TRACK * reserve);
        },
        onResize: () => this.mgr.refitAll(),
      }),
    );
  }
}
