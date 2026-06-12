// A small popup that lists the user's configured launch commands — the Name on
// top, the literal command below it in a muted/monospace font. Shared by the
// pane's "+" button and the folder tree's right-click menu. Picking an item
// runs it in a freshly spawned console; an empty command means a plain shell.
import type { CommandPreset } from '../electron/ipc';

/** An extra non-command action appended below the command list (e.g. "Open in
 *  File Explorer" on the folder tree's right-click menu). */
export interface MenuAction {
  icon: string;
  label: string;
  onSelect: () => void;
}

let active: HTMLElement | null = null;

function onDocPointerDown(e: MouseEvent): void {
  if (active && !active.contains(e.target as Node)) closeCommandMenu();
}

export function closeCommandMenu(): void {
  active?.remove();
  active = null;
  document.removeEventListener('mousedown', onDocPointerDown, true);
}

/**
 * Open the command menu anchored at (x, y). Closes on pick or on any click
 * outside it. Coordinates are clamped to keep the menu on screen.
 */
export function openCommandMenu(
  x: number,
  y: number,
  commands: CommandPreset[],
  onPick: (cmd: CommandPreset) => void,
  extra: MenuAction[] = [],
): void {
  closeCommandMenu();

  const menu = document.createElement('div');
  menu.className =
    'fixed z-50 min-w-56 max-w-80 max-h-80 overflow-auto scroll-area rounded-md border ' +
    'border-edge bg-panel py-1 shadow-lg text-sm';

  if (commands.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'px-3 py-2 text-xs text-muted';
    empty.textContent = 'No commands configured. Add some in Settings.';
    menu.appendChild(empty);
  }

  for (const cmd of commands) {
    const item = document.createElement('button');
    item.className =
      'flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-edge/60';

    const name = document.createElement('span');
    name.className = 'text-fg';
    name.textContent = cmd.name;

    const sub = document.createElement('span');
    sub.className = 'text-xs text-muted font-mono truncate max-w-full';
    sub.textContent = cmd.command.trim() === '' ? 'empty shell' : cmd.command;

    item.append(name, sub);
    item.addEventListener('click', () => {
      closeCommandMenu();
      onPick(cmd);
    });
    menu.appendChild(item);
  }

  if (extra.length > 0) {
    if (commands.length > 0) {
      const hr = document.createElement('div');
      hr.className = 'my-1 border-t border-edge';
      menu.appendChild(hr);
    }
    for (const action of extra) {
      const item = document.createElement('button');
      item.className =
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-edge/60';
      const icon = document.createElement('span');
      icon.className = 'shrink-0 flex items-center text-muted';
      icon.innerHTML = `<iconify-icon icon="${action.icon}"></iconify-icon>`;
      const label = document.createElement('span');
      label.textContent = action.label;
      item.append(icon, label);
      item.addEventListener('click', () => {
        closeCommandMenu();
        action.onSelect();
      });
      menu.appendChild(item);
    }
  }

  document.body.appendChild(menu);
  active = menu;

  // Clamp into the viewport now that the menu has measurable dimensions.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  // Defer wiring the outside-click handler so the opening click doesn't close it.
  setTimeout(() => document.addEventListener('mousedown', onDocPointerDown, true), 0);
}
