// Left pane: a lazily-loaded directory tree rooted at a selectable drive/volume
// (Windows drive letters, macOS volumes), defaulting to the drive that holds the
// user's home folder. Directories expand on click and load their children on
// demand. Right-clicking a directory opens a context menu to start a session there.
import type { DirEntry, Drive } from '../electron/ipc';

// Iconify swaps each `.iconify` placeholder for a fresh SVG, so writing
// `dataset.icon` on the original span has no effect. Render into a stable wrapper
// instead — the Iconify observer renders the new placeholder we drop in.
function setIcon(wrapper: HTMLElement, icon: string): void {
  wrapper.innerHTML = `<span class="iconify" data-icon="${icon}"></span>`;
}

/**
 * Pick the drive to open on startup: the one whose root contains the user's home
 * folder (C:\ on Windows, / on macOS) via longest-prefix match. Falls back to the
 * first drive. Comparison is case-insensitive to tolerate Windows drive casing.
 */
function pickDefaultDrive(drives: Drive[], home: string): Drive | undefined {
  const h = home.toLowerCase();
  let best: Drive | undefined;
  for (const d of drives) {
    if (h.startsWith(d.path.toLowerCase()) && (!best || d.path.length > best.path.length)) {
      best = d;
    }
  }
  return best ?? drives[0];
}

export class FolderTree {
  private readonly root: HTMLElement;
  private menu: HTMLElement | null = null;

  constructor(
    container: HTMLElement,
    private readonly driveSelect: HTMLSelectElement,
    private readonly onNewSession: (folder: string) => void,
  ) {
    this.root = container;
    document.addEventListener('click', () => this.closeMenu());
    this.driveSelect.addEventListener('change', () => {
      void this.setRoot(this.driveSelect.value);
    });
  }

  async init(): Promise<void> {
    const [home, drives] = await Promise.all([window.api.fs.home(), window.api.fs.drives()]);

    this.driveSelect.replaceChildren();
    for (const d of drives) {
      const opt = document.createElement('option');
      opt.value = d.path;
      opt.textContent = d.label;
      this.driveSelect.appendChild(opt);
    }

    const start = pickDefaultDrive(drives, home);
    if (start) this.driveSelect.value = start.path;
    await this.setRoot(start ? start.path : home);
  }

  /** Re-root the tree at the given path and auto-expand its first level. */
  private async setRoot(rootPath: string): Promise<void> {
    this.root.replaceChildren();
    const node = this.makeNode({ name: rootPath, path: rootPath, isDirectory: true }, 0);
    this.root.appendChild(node);
    const row = node.firstElementChild as HTMLElement;
    const chevron = row.children[0] as HTMLElement;
    const icon = row.children[1] as HTMLElement;
    await this.toggle(node, chevron, icon); // children empty → opens (loads + reveals)
  }

  private makeNode(entry: DirEntry, depth: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.dataset['path'] = entry.path;
    wrap.style.setProperty('--depth', String(depth));

    const row = document.createElement('div');
    row.className =
      'flex items-center gap-1 px-2 py-0.5 rounded cursor-pointer hover:bg-edge/60 select-none';
    row.style.paddingLeft = `${8 + depth * 14}px`;

    const chevron = document.createElement('span');
    chevron.className = 'text-muted shrink-0 flex items-center transition-transform';
    setIcon(chevron, entry.isDirectory ? 'lucide:chevron-right' : 'lucide:dot');

    const icon = document.createElement('span');
    icon.className = 'shrink-0 flex items-center text-muted';
    setIcon(icon, entry.isDirectory ? 'lucide:folder' : 'lucide:file');

    const label = document.createElement('span');
    label.className = 'truncate';
    label.textContent = depth === 0 ? entry.path : entry.name;

    row.append(chevron, icon, label);
    wrap.appendChild(row);

    const children = document.createElement('div');
    children.hidden = true;
    wrap.appendChild(children);

    if (entry.isDirectory) {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.toggle(wrap, chevron, icon);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openMenu(e.clientX, e.clientY, entry.path);
      });
    }

    return wrap;
  }

  private async toggle(wrap: HTMLElement, chevron: HTMLElement, icon: HTMLElement): Promise<void> {
    const children = wrap.lastElementChild as HTMLElement;
    const isOpen = !children.hidden;
    if (isOpen) {
      children.hidden = true;
      chevron.style.transform = '';
      setIcon(icon, 'lucide:folder');
      return;
    }
    if (children.childElementCount === 0) await this.expand(wrap);
    children.hidden = false;
    chevron.style.transform = 'rotate(90deg)';
    setIcon(icon, 'lucide:folder-open');
  }

  private async expand(wrap: HTMLElement): Promise<void> {
    const path = wrap.dataset['path']!;
    const children = wrap.lastElementChild as HTMLElement;
    const depth = Number(wrap.style.getPropertyValue('--depth') || 0);
    try {
      const entries = await window.api.fs.listDir(path);
      for (const entry of entries.filter((e) => e.isDirectory)) {
        const child = this.makeNode(entry, depth + 1);
        child.style.setProperty('--depth', String(depth + 1));
        children.appendChild(child);
      }
    } catch {
      /* permission denied / unreadable — leave empty */
    }
  }

  private openMenu(x: number, y: number, folder: string): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className =
      'fixed z-50 min-w-44 rounded-md border border-edge bg-panel py-1 shadow-lg text-sm';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const item = document.createElement('button');
    item.className = 'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-edge/60';
    item.innerHTML = '<span class="iconify" data-icon="lucide:terminal"></span><span>New session here</span>';
    item.addEventListener('click', () => {
      this.closeMenu();
      this.onNewSession(folder);
    });

    menu.appendChild(item);
    document.body.appendChild(menu);
    this.menu = menu;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}
