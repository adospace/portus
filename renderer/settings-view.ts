// The Settings tab's content: a left nav listing setting sections and a right
// content area editing the selected section. It is hosted inside a Pane's
// terminal stack just like a TerminalTab (it implements the same show/hide/
// reparent/fit/dispose surface), so the pane treats it as one more tab.
//
// Today there is a single "Commands" section that edits the list of launch
// commands; the section list is data-driven so more can be added later.
import type { AppSettings, CommandPreset } from '../electron/ipc';
import type { SettingsStore } from './settings-store';

interface Section {
  id: string;
  label: string;
  icon: string;
}

const SECTIONS: Section[] = [{ id: 'commands', label: 'Commands', icon: 'lucide:terminal' }];

export class SettingsView {
  readonly host: HTMLDivElement;
  private readonly contentEl: HTMLDivElement;
  private readonly navBtns = new Map<string, HTMLButtonElement>();
  /** Working copy of the commands, edited in place until the user saves. */
  private commands: CommandPreset[];
  private activeSection = SECTIONS[0]!.id;

  constructor(parent: HTMLElement, private readonly store: SettingsStore) {
    this.commands = this.store.commands().map((c) => ({ ...c }));

    this.host = document.createElement('div');
    this.host.className = 'settings-host flex bg-bg';

    // --- left nav ---
    const nav = document.createElement('div');
    nav.className =
      'w-48 shrink-0 border-r border-edge bg-panel py-2 flex flex-col gap-0.5 scroll-area overflow-auto';
    const navTitle = document.createElement('div');
    navTitle.className = 'px-4 pb-2 text-xs font-semibold uppercase tracking-wide text-muted';
    navTitle.textContent = 'Settings';
    nav.appendChild(navTitle);

    for (const section of SECTIONS) {
      const btn = document.createElement('button');
      btn.className =
        'flex items-center gap-2 mx-2 px-2 py-1.5 rounded text-left text-sm hover:bg-edge/60';
      btn.innerHTML =
        `<span class="iconify" data-icon="${section.icon}"></span><span>${section.label}</span>`;
      btn.addEventListener('click', () => this.selectSection(section.id));
      this.navBtns.set(section.id, btn);
      nav.appendChild(btn);
    }

    // --- right content ---
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'flex-1 min-w-0 overflow-auto scroll-area p-6';

    this.host.append(nav, this.contentEl);
    parent.appendChild(this.host);

    this.selectSection(this.activeSection);
  }

  private selectSection(id: string): void {
    this.activeSection = id;
    for (const [secId, btn] of this.navBtns) {
      const on = secId === id;
      btn.classList.toggle('bg-edge', on);
      btn.classList.toggle('text-fg', on);
      btn.classList.toggle('text-muted', !on);
    }
    if (id === 'commands') this.renderCommands();
  }

  // --- Commands section -------------------------------------------------

  private renderCommands(): void {
    this.contentEl.replaceChildren();

    const header = document.createElement('div');
    header.className = 'mb-4';
    header.innerHTML =
      '<h2 class="text-lg font-semibold text-fg">Commands</h2>' +
      '<p class="mt-1 text-sm text-muted">Launch commands shown in the new-tab (+) menu and ' +
      'the folder tree right-click menu. Each opens a new console and runs its command. ' +
      'Leave the command empty for a plain shell.</p>';
    this.contentEl.appendChild(header);

    const list = document.createElement('div');
    list.className = 'flex flex-col gap-2';
    this.contentEl.appendChild(list);

    const renderRows = (): void => {
      list.replaceChildren();
      this.commands.forEach((cmd, i) => list.appendChild(this.buildCommandRow(cmd, i, renderRows)));
    };
    renderRows();

    const addBtn = document.createElement('button');
    addBtn.className =
      'mt-3 flex items-center gap-2 px-3 py-1.5 rounded border border-edge text-sm ' +
      'text-muted hover:text-fg hover:border-muted';
    addBtn.innerHTML = '<span class="iconify" data-icon="lucide:plus"></span><span>Add command</span>';
    addBtn.addEventListener('click', () => {
      this.commands.push({ name: '', command: '' });
      renderRows();
    });
    this.contentEl.appendChild(addBtn);

    // --- save bar ---
    const bar = document.createElement('div');
    bar.className = 'mt-6 flex items-center gap-3 border-t border-edge pt-4';

    const saveBtn = document.createElement('button');
    saveBtn.className =
      'flex items-center gap-2 px-4 py-1.5 rounded bg-accent text-bg text-sm font-medium ' +
      'hover:opacity-90';
    saveBtn.innerHTML = '<span class="iconify" data-icon="lucide:save"></span><span>Save</span>';

    const status = document.createElement('span');
    status.className = 'text-sm text-idle';

    saveBtn.addEventListener('click', () => {
      void (async () => {
        const next: AppSettings = {
          ...this.store.get(),
          commands: this.commands
            .map((c) => ({ name: c.name.trim(), command: c.command }))
            .filter((c) => c.name !== '' || c.command.trim() !== ''),
        };
        try {
          await this.store.save(next);
          this.commands = next.commands.map((c) => ({ ...c }));
          renderRows();
          status.textContent = 'Saved';
          setTimeout(() => (status.textContent = ''), 2000);
        } catch {
          status.className = 'text-sm text-accent';
          status.textContent = 'Save failed';
        }
      })();
    });

    bar.append(saveBtn, status);
    this.contentEl.appendChild(bar);
  }

  private buildCommandRow(cmd: CommandPreset, index: number, rerender: () => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2';

    const inputCls =
      'bg-bg border border-edge rounded px-2 py-1 text-sm text-fg ' +
      'focus:outline-none focus:border-accent';

    const name = document.createElement('input');
    name.className = `${inputCls} w-48 shrink-0`;
    name.placeholder = 'Name';
    name.value = cmd.name;
    name.addEventListener('input', () => (cmd.name = name.value));

    const command = document.createElement('input');
    command.className = `${inputCls} flex-1 min-w-0 font-mono`;
    command.placeholder = 'Command (empty = plain shell)';
    command.value = cmd.command;
    command.addEventListener('input', () => (cmd.command = command.value));

    const remove = document.createElement('button');
    remove.className =
      'shrink-0 flex items-center justify-center w-8 h-8 rounded text-muted hover:text-accent';
    remove.title = 'Remove';
    remove.innerHTML = '<span class="iconify" data-icon="lucide:trash-2"></span>';
    remove.addEventListener('click', () => {
      this.commands.splice(index, 1);
      rerender();
    });

    row.append(name, command, remove);
    return row;
  }

  // --- TabContent surface (mirrors TerminalTab) -------------------------

  show(): void {
    this.host.hidden = false;
  }

  hide(): void {
    this.host.hidden = true;
  }

  reparent(parent: HTMLElement): void {
    parent.appendChild(this.host);
  }

  fit(): { cols: number; rows: number } {
    return { cols: 0, rows: 0 };
  }

  dispose(): void {
    this.host.remove();
  }
}
