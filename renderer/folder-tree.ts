// Left pane: a lazily-loaded directory tree rooted at a selectable drive/volume
// (Windows drive letters, macOS volumes), defaulting to the drive that holds the
// user's home folder. Directories expand on click and load their children on
// demand. Right-clicking a directory opens a context menu to start a session there.
import type { CommandPreset, DirEntry, Drive } from '../electron/ipc';
import { openCommandMenu } from './command-menu';
import { copyPathAction, revealAction } from './file-manager';

// Render an icon into a stable wrapper via the <iconify-icon> web component, so
// listeners/transforms on the wrapper survive icon changes (e.g. the chevron we
// rotate and re-point as folders expand).
function setIcon(wrapper: HTMLElement, icon: string): void {
  wrapper.innerHTML = `<iconify-icon icon="${icon}"></iconify-icon>`;
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

  constructor(
    container: HTMLElement,
    private readonly driveSelect: HTMLSelectElement,
    private readonly getCommands: () => CommandPreset[],
    private readonly onRunCommand: (folder: string, command: string) => void,
  ) {
    this.root = container;
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

    // Mark git work trees with a small symbol after the name; the repo name is
    // shown on hover. Best-effort + async — non-repos get nothing.
    if (entry.isDirectory) {
      const repo = document.createElement('span');
      repo.className = 'git-repo shrink-0 ml-1 flex items-center text-muted text-[11px]';
      repo.hidden = true;
      repo.innerHTML = '<iconify-icon icon="lucide:git-branch"></iconify-icon>';
      row.append(repo);
      void window.api.git.info(entry.path).then((info) => {
        if (!info) return;
        repo.title = info.name;
        repo.hidden = false;
      });
    }

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
        this.openMenu(e.clientX, e.clientY, entry.path, wrap);
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

  private openMenu(x: number, y: number, folder: string, wrap: HTMLElement): void {
    openCommandMenu(x, y, this.getCommands(), (cmd) => this.onRunCommand(folder, cmd.command), [
      { icon: 'lucide:refresh-cw', label: 'Refresh', onSelect: () => void this.refresh(wrap) },
      revealAction(folder),
      copyPathAction(folder),
    ]);
  }

  /** Re-read a directory's children from disk: clears the loaded child nodes and,
   *  if the node is currently expanded, reloads them (a collapsed node simply
   *  re-fetches on its next expand). */
  private async refresh(wrap: HTMLElement): Promise<void> {
    const children = wrap.lastElementChild as HTMLElement;
    const wasOpen = !children.hidden;
    children.replaceChildren();
    if (wasOpen) await this.expand(wrap);
  }

  // --- active-folder highlighting --------------------------------------
  // When the active terminal tab changes, the tree reveals the session's folder
  // (expanding ancestors) and accents its icon plus every ancestor icon, so the
  // linked directory stands out without tinting whole rows.

  private highlightedIcons: HTMLElement[] = [];

  /** Reveal `path` in the tree (expanding ancestors) and accent the icons along the
   *  chain from the root down to it. Passing null just clears any existing highlight. */
  async highlightFolder(path: string | null): Promise<void> {
    this.clearHighlight();
    if (!path) return;
    const node = await this.reveal(path);
    if (!node) return;

    // Walk up from the target wrapper to the root, accenting each node's icon. Climb
    // one level at a time: node wrappers carry a data-path (accented), the children
    // containers between them don't (skipped), and this.root is the stop sentinel.
    let n: HTMLElement | null = node;
    let isLeaf = true;
    while (n && n !== this.root) {
      if (n.dataset['path']) {
        const row = n.firstElementChild as HTMLElement;
        const icon = row.children[1] as HTMLElement; // [chevron, icon, label]
        icon.classList.remove('text-muted');
        icon.classList.add(isLeaf ? 'text-accent' : 'text-accent/60');
        this.highlightedIcons.push(icon);
        isLeaf = false;
      }
      n = n.parentElement;
    }

    node.firstElementChild?.scrollIntoView({ block: 'nearest' });
  }

  private clearHighlight(): void {
    for (const icon of this.highlightedIcons) {
      icon.classList.remove('text-accent', 'text-accent/60');
      icon.classList.add('text-muted');
    }
    this.highlightedIcons = [];
  }

  /** Expand the tree down to `target`, returning its node wrapper (or the deepest
   *  reachable ancestor if it can't be fully revealed). */
  private async reveal(target: string): Promise<HTMLElement | null> {
    const t = normPath(target);
    let current = this.root.firstElementChild as HTMLElement | null;
    if (!current || !isPathPrefix(normPath(current.dataset['path'] ?? ''), t)) return null;

    while (normPath(current.dataset['path'] ?? '') !== t) {
      await this.ensureExpanded(current);
      const children = current.lastElementChild as HTMLElement;
      let next: HTMLElement | null = null;
      for (const child of Array.from(children.children) as HTMLElement[]) {
        if (isPathPrefix(normPath(child.dataset['path'] ?? ''), t)) {
          next = child;
          break;
        }
      }
      if (!next) return current; // can't descend further (not loaded / no access)
      current = next;
    }
    return current;
  }

  /** Open a directory node if it isn't already expanded. */
  private async ensureExpanded(wrap: HTMLElement): Promise<void> {
    const children = wrap.lastElementChild as HTMLElement;
    if (!children.hidden) return;
    const row = wrap.firstElementChild as HTMLElement;
    const chevron = row.children[0] as HTMLElement;
    const icon = row.children[1] as HTMLElement;
    await this.toggle(wrap, chevron, icon);
  }
}

/** Normalise a path for comparison: lowercase, forward slashes, no trailing slash. */
function normPath(p: string): string {
  let s = p.toLowerCase().replace(/\\/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

/** Whether `child` equals `parent` or sits beneath it (both already normalised). */
function isPathPrefix(parent: string, child: string): boolean {
  if (parent === child) return true;
  const base = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(base);
}
