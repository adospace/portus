// Left pane bottom section: a persistent list of "pinned" folders for quick
// access. A folder is pinned from the folder-tree right-click menu or a terminal
// tab's right-click menu. Clicking a pinned entry opens the same command menu the
// "+" button shows, so you can launch a session there in one move. The list is
// stored in settings (`pinnedFolders`) so it survives restarts. The whole panel
// hides itself while the list is empty.
import type { CommandPreset } from '../electron/ipc';
import { openCommandMenu } from './command-menu';
import { copyPathAction, revealAction } from './file-manager';

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Normalise a path for de-duplication: lowercase, forward slashes, no trailing slash. */
function normPath(p: string): string {
  let s = p.toLowerCase().replace(/\\/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

export class PinnedFolders {
  private folders: string[] = [];

  constructor(
    private readonly panel: HTMLElement,
    private readonly list: HTMLElement,
    private readonly getCommands: () => CommandPreset[],
    private readonly onRunCommand: (folder: string, command: string) => void,
    /** Persist the current list (called after every pin/unpin). */
    private readonly persist: (folders: string[]) => void,
  ) {}

  /** Seed the list from persisted settings (called once at startup). Dedupes and
   *  drops blanks defensively. Does not persist (it's already the stored value). */
  setFolders(folders: string[]): void {
    const seen = new Set<string>();
    this.folders = [];
    for (const f of folders) {
      const key = normPath(f);
      if (!f || seen.has(key)) continue;
      seen.add(key);
      this.folders.push(f);
    }
    this.render();
  }

  isPinned(folder: string): boolean {
    const key = normPath(folder);
    return this.folders.some((f) => normPath(f) === key);
  }

  /** Pin a folder (no-op if already pinned), persist, and re-render. */
  pin(folder: string): void {
    if (!folder || this.isPinned(folder)) return;
    this.folders.push(folder);
    this.persist(this.folders);
    this.render();
  }

  /** Unpin a folder (no-op if absent), persist, and re-render. */
  unpin(folder: string): void {
    const key = normPath(folder);
    const next = this.folders.filter((f) => normPath(f) !== key);
    if (next.length === this.folders.length) return;
    this.folders = next;
    this.persist(this.folders);
    this.render();
  }

  private render(): void {
    this.panel.hidden = this.folders.length === 0;
    this.list.replaceChildren();
    for (const folder of this.folders) this.list.appendChild(this.makeRow(folder));
  }

  private makeRow(folder: string): HTMLElement {
    const row = document.createElement('div');
    row.className =
      'group flex items-center gap-2 px-3 py-0.5 rounded cursor-pointer hover:bg-edge/60 select-none';
    row.title = folder;

    const icon = document.createElement('span');
    icon.className = 'shrink-0 flex items-center text-muted';
    icon.innerHTML = '<iconify-icon icon="lucide:folder"></iconify-icon>';

    const label = document.createElement('span');
    label.className = 'flex-1 truncate';
    label.textContent = baseName(folder);

    const remove = document.createElement('span');
    remove.className =
      'shrink-0 flex items-center opacity-0 group-hover:opacity-100 text-muted hover:text-accent';
    remove.title = 'Unpin';
    remove.innerHTML = '<iconify-icon icon="lucide:x"></iconify-icon>';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.unpin(folder);
    });

    row.append(icon, label, remove);

    // Click → launch a session in this folder (same command menu as the + button).
    row.addEventListener('click', () => {
      const r = row.getBoundingClientRect();
      openCommandMenu(r.left, r.bottom, this.getCommands(), (cmd) =>
        this.onRunCommand(folder, cmd.command),
      );
    });

    // Right-click → the standard reveal / copy / unpin actions, with the command
    // list below them so you can launch a session here (same as the + button).
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCommandMenu(
        e.clientX,
        e.clientY,
        this.getCommands(),
        (cmd) => this.onRunCommand(folder, cmd.command),
        [
          revealAction(folder),
          copyPathAction(folder),
          { icon: 'lucide:pin-off', label: 'Unpin', onSelect: () => this.unpin(folder) },
        ],
      );
    });

    return row;
  }
}
