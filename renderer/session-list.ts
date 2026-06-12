// Right pane: the list of sessions (live and historical) sourced from the
// session store. Clicking a row asks the app to restore that session. A search
// box filters the list by session title, folder name, or full path.
import { isMeaningfulTitle, type PersistedSession } from '../electron/ipc';
import { fileManagerLabel, openInFileManager } from './file-manager';

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The text shown as a row's primary label: the agent title, else the folder name. */
function displayName(s: PersistedSession): string {
  return isMeaningfulTitle(s.title) ? s.title!.trim() : baseName(s.folder);
}

export class SessionList {
  private sessions: PersistedSession[] = [];
  private query = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly onRestore: (session: PersistedSession) => void,
    search?: HTMLInputElement,
  ) {
    search?.addEventListener('input', () => {
      this.query = search.value.trim().toLowerCase();
      this.render();
    });
  }

  async refresh(): Promise<void> {
    try {
      this.sessions = await window.api.sessions.list();
    } catch {
      // Persistence unavailable; show nothing rather than erroring.
      this.sessions = [];
    }
    this.render();
  }

  private matches(s: PersistedSession): boolean {
    if (!this.query) return true;
    return (
      displayName(s).toLowerCase().includes(this.query) ||
      s.folder.toLowerCase().includes(this.query) ||
      (s.title?.toLowerCase().includes(this.query) ?? false)
    );
  }

  private render(): void {
    this.container.replaceChildren();
    const visible = this.sessions
      .filter((s) => this.matches(s))
      .sort((a, b) => b.lastActive.localeCompare(a.lastActive));

    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'px-3 py-4 text-xs text-muted';
      empty.textContent = this.query ? 'No matching sessions.' : 'No sessions yet.';
      this.container.appendChild(empty);
      return;
    }

    for (const s of visible) {
      this.container.appendChild(this.buildRow(s));
    }
  }

  private buildRow(s: PersistedSession): HTMLElement {
    // A row can't be a <button> any more: it now hosts its own action buttons
    // (open folder / delete), and nesting interactive controls inside a button is
    // invalid. So it's a div whose body click restores, with hover-revealed icons.
    const row = document.createElement('div');
    row.className =
      'group relative flex flex-col gap-0.5 px-3 py-2 cursor-pointer hover:bg-edge/60 border-b border-edge/40';

    const top = document.createElement('div');
    top.className = 'flex items-center gap-2';
    const icon = document.createElement('iconify-icon');
    icon.className = 'text-muted shrink-0';
    icon.setAttribute('icon', 'lucide:folder');
    const name = document.createElement('span');
    name.className = 'truncate font-medium';
    name.textContent = displayName(s);
    const time = document.createElement('span');
    time.className = 'ml-auto shrink-0 text-xs text-muted group-hover:invisible';
    time.textContent = shortTime(s.lastActive);
    top.append(icon, name, time);

    const bottom = document.createElement('div');
    bottom.className = 'truncate text-xs text-muted';
    bottom.textContent = s.folder;
    bottom.title = s.folder;

    // Restore on a body click, but not when an action button was the target.
    row.addEventListener('click', () => this.onRestore(s));

    // Hover actions, pinned top-right over the timestamp.
    const actions = document.createElement('div');
    actions.className =
      'absolute right-2 top-2 flex items-center gap-1 opacity-0 group-hover:opacity-100';

    const open = this.actionButton('lucide:folder-open', fileManagerLabel(), 'hover:text-fg');
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      openInFileManager(s.folder);
    });

    const del = this.actionButton('lucide:trash-2', 'Delete session', 'hover:text-danger');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!window.confirm(`Delete session "${displayName(s)}"? This can't be undone.`)) return;
      void this.deleteSession(s.id);
    });

    actions.append(open, del);
    row.append(top, bottom, actions);
    return row;
  }

  private actionButton(icon: string, title: string, hoverCls: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.title = title;
    btn.className =
      `flex items-center justify-center w-6 h-6 rounded bg-panel/80 text-muted ${hoverCls}`;
    btn.innerHTML = `<iconify-icon icon="${icon}"></iconify-icon>`;
    return btn;
  }

  private async deleteSession(id: string): Promise<void> {
    try {
      await window.api.sessions.delete(id);
    } catch {
      /* persistence unavailable — nothing to remove */
    }
    await this.refresh();
  }
}
