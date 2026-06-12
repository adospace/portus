// Right pane: the list of sessions (live and historical) sourced from the
// sidecar. Clicking a row asks the app to restore that session. A search box
// filters the list by session title, folder name, or full path.
import type { PersistedSession } from '../electron/ipc';

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
  return s.title?.trim() || baseName(s.folder);
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
      // Sidecar offline; show nothing rather than erroring.
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
      const row = document.createElement('button');
      row.className =
        'flex w-full flex-col gap-0.5 px-3 py-2 text-left cursor-pointer hover:bg-edge/60 border-b border-edge/40';
      row.addEventListener('click', () => this.onRestore(s));

      const top = document.createElement('div');
      top.className = 'flex items-center gap-2';
      const icon = document.createElement('span');
      icon.className = 'iconify text-muted shrink-0';
      icon.dataset.icon = 'lucide:folder';
      const name = document.createElement('span');
      name.className = 'truncate font-medium';
      name.textContent = displayName(s);
      const time = document.createElement('span');
      time.className = 'ml-auto shrink-0 text-xs text-muted';
      time.textContent = shortTime(s.lastActive);
      top.append(icon, name, time);

      const bottom = document.createElement('div');
      bottom.className = 'truncate text-xs text-muted';
      bottom.textContent = s.folder;
      bottom.title = s.folder;

      row.append(top, bottom);
      this.container.appendChild(row);
    }
  }
}
