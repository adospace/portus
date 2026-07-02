// Left pane: a lazily-loaded directory tree rooted at a selectable drive/volume
// (Windows drive letters, macOS volumes), defaulting to the drive that holds the
// user's home folder. Directories expand on click and load their children on
// demand. Right-clicking a directory opens a context menu to start a session there.
import type { CommandPreset, DirEntry, Drive, GitFileStatus } from '../electron/ipc';
import { openCommandMenu } from './command-menu';
import { openContextMenu } from './context-menu';
import { copyFilePathLabel, copyPathAction, openInFileManager, revealAction, trashLabel } from './file-manager';

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
    private readonly onPinFolder: (folder: string) => void,
    /** A directory row was clicked → became the "selected" folder. */
    private readonly onSelectFolder: (folder: string) => void,
    /** A file row was double-clicked → open it (editor for text, OS handler else). */
    private readonly onOpenFile: (path: string) => void,
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

    // Keep the tree in sync with disk + git so the user never needs "Refresh".
    this.startGitWatch();
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
    wrap.dataset['isdir'] = entry.isDirectory ? '1' : '';
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
        this.select(row, entry.path);
        void this.toggle(wrap, chevron, icon);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openMenu(e.clientX, e.clientY, entry.path, wrap);
      });
    } else {
      // Files: double-click opens (Monaco for text, OS default handler otherwise).
      row.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.onOpenFile(entry.path);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openFileMenu(e.clientX, e.clientY, entry.path, wrap);
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
      for (const entry of entries) {
        const child = this.makeNode(entry, depth + 1);
        child.style.setProperty('--depth', String(depth + 1));
        children.appendChild(child);
      }
    } catch {
      /* permission denied / unreadable — leave empty */
    }
    // Decorate the freshly-listed children with their git working-tree status
    // (best-effort, async — non-repos and clean files get nothing).
    void this.decorateGitStatus(path, children);
  }

  // --- git status decoration -------------------------------------------
  // Files that git reports as changed get a colored name + a one-letter badge
  // (M/A/U/D/R); directories that contain (or are) changes get a small dot, so
  // changes are visible without expanding every folder.

  private async decorateGitStatus(path: string, children: HTMLElement): Promise<void> {
    let statuses: GitFileStatus[];
    try {
      statuses = await window.api.git.status(path);
    } catch {
      return; // git unavailable / not a repo — never decorated, nothing to clear
    }

    const byPath = new Map<string, GitFileStatus['status']>();
    for (const s of statuses) byPath.set(normPath(s.path), s.status);

    // Re-apply from a clean slate every call so the live poll can *remove* a badge
    // when a file's change was committed/stashed (not just add new ones).
    for (const childWrap of Array.from(children.children) as HTMLElement[]) {
      const p = normPath(childWrap.dataset['path'] ?? '');
      if (!p) continue;
      const row = childWrap.firstElementChild as HTMLElement;
      if (childWrap.dataset['isdir'] === '1') {
        // Direct hit (an untracked directory) or a roll-up (contains a change).
        let status = byPath.get(p);
        if (!status) {
          const base = `${p}/`;
          if (statuses.some((s) => normPath(s.path).startsWith(base))) status = 'modified';
        }
        clearDirDecoration(row);
        if (status) markDir(row, status);
      } else {
        clearFileDecoration(row);
        const status = byPath.get(p);
        if (status) markFile(row, status);
      }
    }
  }

  // --- live git/disk polling -------------------------------------------
  // A background sweep keeps the tree in sync with disk + git so the user never
  // has to hit "Refresh": every expanded directory is re-listed (new files
  // appear, deleted ones drop out) and re-decorated with current git status.

  private pollTimer: number | null = null;
  private polling = false;

  /** Start the background sync loop (idempotent). */
  startGitWatch(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // a slow previous sweep is still running — skip this tick
    this.polling = true;
    try {
      const dirs: HTMLElement[] = [];
      this.collectExpanded(this.root, dirs);
      for (const wrap of dirs) await this.syncDir(wrap);
    } finally {
      this.polling = false;
    }
  }

  /** Collect every currently-expanded directory wrapper under `container`. */
  private collectExpanded(container: HTMLElement, out: HTMLElement[]): void {
    for (const wrap of Array.from(container.children) as HTMLElement[]) {
      if (wrap.dataset['isdir'] !== '1') continue;
      const kids = wrap.lastElementChild as HTMLElement | null;
      if (!kids || kids.hidden) continue;
      out.push(wrap);
      this.collectExpanded(kids, out);
    }
  }

  /** Reconcile one expanded directory's child nodes with disk (add new entries,
   *  drop vanished ones) and re-apply git decorations — preserving existing nodes
   *  (and their expanded subtrees), the current selection, and scroll position. */
  private async syncDir(wrap: HTMLElement): Promise<void> {
    const path = wrap.dataset['path'];
    if (!path) return;
    const kids = wrap.lastElementChild as HTMLElement | null;
    if (!kids || kids.hidden) return; // collapsed since it was collected

    let entries: DirEntry[];
    try {
      entries = await window.api.fs.listDir(path);
    } catch {
      return; // unreadable now — leave the loaded nodes in place
    }

    const depth = Number(wrap.style.getPropertyValue('--depth') || 0);
    const existing = new Map<string, HTMLElement>();
    for (const c of Array.from(kids.children) as HTMLElement[]) {
      existing.set(normPath(c.dataset['path'] ?? ''), c);
    }

    // Walk disk order, inserting a node for each new entry in place while leaving
    // existing nodes (and any expanded subtrees beneath them) untouched.
    const wanted = new Set<string>();
    let prev: HTMLElement | null = null;
    for (const entry of entries) {
      const key = normPath(entry.path);
      wanted.add(key);
      let node = existing.get(key);
      if (!node) {
        node = this.makeNode(entry, depth + 1);
        node.style.setProperty('--depth', String(depth + 1));
        if (prev) prev.after(node);
        else kids.prepend(node);
      }
      prev = node;
    }

    // Drop nodes whose files/folders no longer exist on disk.
    for (const [key, node] of existing) {
      if (!wanted.has(key)) node.remove();
    }

    await this.decorateGitStatus(path, kids);
  }

  // --- folder selection -------------------------------------------------
  // Clicking a directory row "selects" it: the row gets a persistent gray tint and
  // the selected folder is reported so the session list can mark matching rows.

  private selectedRow: HTMLElement | null = null;

  private select(row: HTMLElement, path: string): void {
    if (this.selectedRow === row) return;
    this.selectedRow?.classList.remove('bg-edge');
    this.selectedRow = row;
    row.classList.add('bg-edge');
    this.onSelectFolder(path);
  }

  private openMenu(x: number, y: number, folder: string, wrap: HTMLElement): void {
    openCommandMenu(x, y, this.getCommands(), (cmd) => this.onRunCommand(folder, cmd.command), [
      { icon: 'lucide:refresh-cw', label: 'Refresh', onSelect: () => void this.refresh(wrap) },
      { icon: 'lucide:pin', label: 'Pin folder', onSelect: () => this.onPinFolder(folder) },
      revealAction(folder),
      copyPathAction(folder),
    ]);
  }

  /** Right-click on a file row: open it in the app, hand it to the OS default
   *  handler, copy its path, or move it to the OS trash. */
  private openFileMenu(x: number, y: number, path: string, wrap: HTMLElement): void {
    openContextMenu(x, y, [
      { icon: 'lucide:file-pen', label: 'Open', onSelect: () => this.onOpenFile(path) },
      { icon: 'lucide:external-link', label: 'Open with default app', onSelect: () => openInFileManager(path) },
      copyPathAction(path, copyFilePathLabel),
      'separator',
      { icon: 'lucide:trash-2', label: trashLabel(), danger: true, onSelect: () => void this.trashFile(path, wrap) },
    ]);
  }

  /** Move a file to the OS Recycle Bin / Trash and drop its node from the tree. */
  private async trashFile(path: string, wrap: HTMLElement): Promise<void> {
    try {
      await window.api.shell.trashItem(path);
      wrap.remove();
    } catch {
      /* couldn't trash (permission / in use) — leave the node in place */
    }
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

/** How often the background sweep re-lists expanded dirs + re-reads git status. */
const POLL_INTERVAL_MS = 4000;

/** Decoration (text color + badge letter) for each git working-tree status. */
const STATUS_STYLE: Record<GitFileStatus['status'], { color: string; badge: string; title: string }> = {
  modified: { color: 'text-warn', badge: 'M', title: 'Modified' },
  added: { color: 'text-idle', badge: 'A', title: 'Added' },
  untracked: { color: 'text-idle', badge: 'U', title: 'Untracked' },
  deleted: { color: 'text-danger', badge: 'D', title: 'Deleted' },
  renamed: { color: 'text-warn', badge: 'R', title: 'Renamed' },
  conflict: { color: 'text-danger', badge: '!', title: 'Conflict' },
};

/** Every color a git status can paint, for resetting a row before re-decorating. */
const STATUS_COLORS = Array.from(new Set(Object.values(STATUS_STYLE).map((s) => s.color)));

/** Strip any git decoration from a file row, restoring its base (muted) look.
 *  Files are never part of the active-folder accent chain, so re-muting is safe. */
function clearFileDecoration(row: HTMLElement): void {
  const icon = row.children[1] as HTMLElement | undefined;
  const label = row.children[2] as HTMLElement | undefined;
  for (const c of STATUS_COLORS) {
    icon?.classList.remove(c);
    label?.classList.remove(c);
  }
  icon?.classList.add('text-muted');
  row.querySelector('.git-status')?.remove();
}

/** Remove the roll-up "contains changes" dot from a directory row. */
function clearDirDecoration(row: HTMLElement): void {
  row.querySelector('.git-status-dot')?.remove();
}

/** Color a file row's name + icon by its git status and append a letter badge. */
function markFile(row: HTMLElement, status: GitFileStatus['status']): void {
  if (row.querySelector('.git-status')) return; // already decorated
  const style = STATUS_STYLE[status];
  // row = [chevron, icon, label]
  const icon = row.children[1] as HTMLElement | undefined;
  const label = row.children[2] as HTMLElement | undefined;
  icon?.classList.remove('text-muted');
  icon?.classList.add(style.color);
  label?.classList.add(style.color);
  const badge = document.createElement('span');
  badge.className = `git-status ml-auto pl-2 shrink-0 text-[11px] font-semibold ${style.color}`;
  badge.textContent = style.badge;
  badge.title = `${style.title} (git)`;
  row.appendChild(badge);
}

/** Mark a directory row that contains (or is) a change with a small colored dot. */
function markDir(row: HTMLElement, status: GitFileStatus['status']): void {
  if (row.querySelector('.git-status-dot')) return;
  const style = STATUS_STYLE[status];
  const dot = document.createElement('span');
  dot.className =
    `git-status-dot ml-auto shrink-0 w-1.5 h-1.5 rounded-full ${style.color.replace('text-', 'bg-')}`;
  dot.title = 'Contains changes (git)';
  row.appendChild(dot);
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
