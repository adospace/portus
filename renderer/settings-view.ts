// The Settings tab's content: a left nav listing setting sections and a right
// content area editing the selected section. It is hosted inside a Pane's
// terminal stack just like a TerminalTab (it implements the same show/hide/
// reparent/fit/dispose surface), so the pane treats it as one more tab.
//
// Today there is a single "Commands" section that edits the list of launch
// commands; the section list is data-driven so more can be added later.
import type { AppSettings, CommandPreset, GeneralSettings, ThemeChoice } from '../electron/ipc';
import type { SettingsStore } from './settings-store';
import type { ThemeManager } from './theme';

interface Section {
  id: string;
  label: string;
  icon: string;
}

const SECTIONS: Section[] = [
  { id: 'general', label: 'General', icon: 'lucide:settings-2' },
  { id: 'commands', label: 'Commands', icon: 'lucide:terminal' },
];

export class SettingsView {
  readonly host: HTMLDivElement;
  private readonly contentEl: HTMLDivElement;
  private readonly navBtns = new Map<string, HTMLButtonElement>();
  /** Working copy of the commands, edited in place until the user saves. */
  private commands: CommandPreset[];
  /** Working copy of the general settings, edited in place until the user saves. */
  private general: GeneralSettings;
  private activeSection = SECTIONS[0]!.id;
  /** Index of the command row currently being dragged, or null. */
  private dragIndex: number | null = null;

  constructor(
    parent: HTMLElement,
    private readonly store: SettingsStore,
    private readonly theme: ThemeManager | null,
  ) {
    this.commands = this.store.commands().map((c) => ({ ...c }));
    this.general = { ...this.store.general() };

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
        `<iconify-icon icon="${section.icon}"></iconify-icon><span>${section.label}</span>`;
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
    if (id === 'general') this.renderGeneral();
    if (id === 'commands') this.renderCommands();
  }

  // --- General section --------------------------------------------------

  private renderGeneral(): void {
    this.contentEl.replaceChildren();

    const header = document.createElement('div');
    header.className = 'mb-4';
    header.innerHTML =
      '<h2 class="text-lg font-semibold text-fg">General</h2>' +
      '<p class="mt-1 text-sm text-muted">Defaults for new sessions and history retention.</p>';
    this.contentEl.appendChild(header);

    const fields = document.createElement('div');
    fields.className = 'flex flex-col gap-6 max-w-xl';
    this.contentEl.appendChild(fields);

    const inputCls =
      'bg-bg border border-edge rounded px-2 py-1 text-sm text-fg ' +
      'focus:outline-none focus:border-accent';

    // --- Theme (system / light / dark) ---
    const themeField = document.createElement('div');
    themeField.className = 'flex flex-col gap-1';
    themeField.innerHTML =
      '<label class="text-sm font-medium text-fg">Theme</label>' +
      '<p class="text-xs text-muted">Follow the operating system, or force a light or dark scheme.</p>';
    const themeSelect = document.createElement('select');
    themeSelect.className = `${inputCls} mt-1 w-40 cursor-pointer hover:border-muted`;
    for (const [value, label] of [
      ['system', 'System'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      themeSelect.appendChild(opt);
    }
    themeSelect.value = this.general.theme;
    themeSelect.addEventListener('change', () => {
      const choice = themeSelect.value as ThemeChoice;
      this.general.theme = choice;
      this.theme?.set(choice); // applies live, app-wide
      void this.store.setTheme(choice); // and persists immediately (not Save-gated)
    });
    themeField.appendChild(themeSelect);

    // --- Default folder (text input + Browse button) ---
    const folderField = document.createElement('div');
    folderField.className = 'flex flex-col gap-1';
    folderField.innerHTML =
      '<label class="text-sm font-medium text-fg">Default folder for new sessions</label>' +
      '<p class="text-xs text-muted">Opened when you start a session from the tab bar (+) ' +
      'button. Leave empty to use your home folder.</p>';

    const folderRow = document.createElement('div');
    folderRow.className = 'mt-1 flex items-center gap-2';
    const folderInput = document.createElement('input');
    folderInput.className = `${inputCls} flex-1 min-w-0 font-mono`;
    folderInput.placeholder = 'Home folder';
    folderInput.value = this.general.defaultFolder;
    folderInput.addEventListener('input', () => (this.general.defaultFolder = folderInput.value));

    const browse = document.createElement('button');
    browse.className =
      'shrink-0 flex items-center gap-2 px-3 py-1.5 rounded border border-edge text-sm ' +
      'text-muted hover:text-fg hover:border-muted';
    browse.innerHTML =
      '<iconify-icon icon="lucide:folder-open"></iconify-icon><span>Browse…</span>';
    browse.addEventListener('click', () => {
      void (async () => {
        const picked = await window.api.fs.pickFolder();
        if (picked) {
          this.general.defaultFolder = picked;
          folderInput.value = picked;
        }
      })();
    });

    folderRow.append(folderInput, browse);
    folderField.appendChild(folderRow);

    // --- Retention days ---
    const daysField = document.createElement('div');
    daysField.className = 'flex flex-col gap-1';
    daysField.innerHTML =
      '<label class="text-sm font-medium text-fg">Keep sessions for (days)</label>' +
      '<p class="text-xs text-muted">History older than this is removed on startup.</p>';
    const daysInput = document.createElement('input');
    daysInput.type = 'number';
    daysInput.min = '1';
    daysInput.className = `${inputCls} mt-1 w-28`;
    daysInput.value = String(this.general.sessionRetentionDays);
    daysInput.addEventListener('input', () => {
      const n = Math.floor(Number(daysInput.value));
      this.general.sessionRetentionDays = Number.isFinite(n) && n > 0 ? n : 30;
    });
    daysField.appendChild(daysInput);

    fields.append(themeField, folderField, daysField);

    // --- save bar ---
    const bar = document.createElement('div');
    bar.className = 'mt-6 flex items-center gap-3 border-t border-edge pt-4';
    const saveBtn = document.createElement('button');
    saveBtn.className =
      'flex items-center gap-2 px-4 py-1.5 rounded bg-accent text-bg text-sm font-medium ' +
      'hover:opacity-90';
    saveBtn.innerHTML = '<iconify-icon icon="lucide:save"></iconify-icon><span>Save</span>';
    const status = document.createElement('span');
    status.className = 'text-sm text-idle';

    saveBtn.addEventListener('click', () => {
      void (async () => {
        // Normalise on save so a blank/invalid day count can't be persisted.
        const days = Math.floor(this.general.sessionRetentionDays);
        const general: GeneralSettings = {
          defaultFolder: this.general.defaultFolder.trim(),
          sessionRetentionDays: Number.isFinite(days) && days > 0 ? days : 30,
          theme: this.general.theme,
          // Not edited here — the title bar toggles it live, so read the current
          // value rather than the snapshot this view took when it opened.
          showSessions: this.store.general().showSessions,
        };
        const next: AppSettings = { ...this.store.get(), general };
        try {
          await this.store.save(next);
          this.general = { ...general };
          daysInput.value = String(general.sessionRetentionDays);
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
    addBtn.innerHTML = '<iconify-icon icon="lucide:plus"></iconify-icon><span>Add command</span>';
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
    saveBtn.innerHTML = '<iconify-icon icon="lucide:save"></iconify-icon><span>Save</span>';

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
    row.className = 'flex items-center gap-2 rounded';

    const inputCls =
      'bg-bg border border-edge rounded px-2 py-1 text-sm text-fg ' +
      'focus:outline-none focus:border-accent';

    // --- drag handle (the only part that initiates a drag) ---
    const grip = document.createElement('button');
    grip.className =
      'shrink-0 flex items-center justify-center w-6 h-8 rounded text-muted ' +
      'hover:text-fg cursor-grab active:cursor-grabbing';
    grip.title = 'Drag to reorder';
    grip.innerHTML = '<iconify-icon icon="lucide:grip-vertical"></iconify-icon>';
    // Rows are only draggable while the pointer is on the grip, so the text
    // inputs stay selectable.
    grip.addEventListener('mousedown', () => (row.draggable = true));
    const stopDrag = () => (row.draggable = false);
    grip.addEventListener('mouseup', stopDrag);

    row.addEventListener('dragstart', (e) => {
      this.dragIndex = index;
      row.classList.add('opacity-40');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('opacity-40');
      stopDrag();
    });
    row.addEventListener('dragover', (e) => {
      if (this.dragIndex === null || this.dragIndex === index) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this.dragIndex;
      this.dragIndex = null;
      if (from === null || from === index) return;
      const [moved] = this.commands.splice(from, 1);
      if (moved) this.commands.splice(index, 0, moved);
      rerender();
    });

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
    remove.innerHTML = '<iconify-icon icon="lucide:trash-2"></iconify-icon>';
    remove.addEventListener('click', () => {
      this.commands.splice(index, 1);
      rerender();
    });

    row.append(grip, name, command, remove);
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
