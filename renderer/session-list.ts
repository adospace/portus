// Right pane: the list of sessions (live and historical) sourced from the
// sidecar. Clicking a row asks the app to restore that session.
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

export class SessionList {
  constructor(
    private readonly container: HTMLElement,
    private readonly onRestore: (session: PersistedSession) => void,
  ) {}

  async refresh(): Promise<void> {
    let sessions: PersistedSession[] = [];
    try {
      sessions = await window.api.sessions.list();
    } catch {
      // Sidecar offline; show nothing rather than erroring.
    }
    this.render(sessions);
  }

  private render(sessions: PersistedSession[]): void {
    this.container.replaceChildren();
    if (sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'px-3 py-4 text-xs text-muted';
      empty.textContent = 'No sessions yet.';
      this.container.appendChild(empty);
      return;
    }

    for (const s of [...sessions].sort((a, b) => b.lastActive.localeCompare(a.lastActive))) {
      const row = document.createElement('button');
      row.className =
        'flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-edge/60 border-b border-edge/40';
      row.addEventListener('click', () => this.onRestore(s));

      const top = document.createElement('div');
      top.className = 'flex items-center gap-2';
      top.innerHTML =
        '<span class="iconify text-muted" data-icon="lucide:folder"></span>' +
        `<span class="truncate font-medium">${baseName(s.folder)}</span>` +
        `<span class="ml-auto text-xs text-muted">${shortTime(s.lastActive)}</span>`;

      const bottom = document.createElement('div');
      bottom.className = 'flex items-center gap-3 text-xs text-muted';
      bottom.innerHTML =
        `<span>$${s.totalCost.toFixed(4)}</span>` +
        `<span>${s.totalTokens.toLocaleString()} tok</span>`;

      row.append(top, bottom);
      this.container.appendChild(row);
    }
  }
}
