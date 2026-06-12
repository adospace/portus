// A small generic context menu: a vertical list of items (optional Lucide icon +
// label) interleaved with separators. Used for a tab's right-click actions —
// relocate it to a neighbouring pane, or close it. Closes on pick or on any
// click outside it; coordinates are clamped to keep the menu on screen.

export interface ContextMenuItem {
  /** Lucide icon name, e.g. 'lucide:arrow-left'. */
  icon?: string;
  label: string;
  /** Tint the item as a destructive action (e.g. Close). */
  danger?: boolean;
  onSelect: () => void;
}

/** A menu entry: an actionable item or a horizontal divider. */
export type ContextMenuEntry = ContextMenuItem | 'separator';

let active: HTMLElement | null = null;

function onDocPointerDown(e: MouseEvent): void {
  if (active && !active.contains(e.target as Node)) closeContextMenu();
}

export function closeContextMenu(): void {
  active?.remove();
  active = null;
  document.removeEventListener('mousedown', onDocPointerDown, true);
}

/** Open a context menu anchored at (x, y) listing the given entries. */
export function openContextMenu(x: number, y: number, entries: ContextMenuEntry[]): void {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className =
    'fixed z-50 min-w-44 rounded-md border border-edge bg-panel py-1 shadow-lg text-sm';

  for (const entry of entries) {
    if (entry === 'separator') {
      const hr = document.createElement('div');
      hr.className = 'my-1 border-t border-edge';
      menu.appendChild(hr);
      continue;
    }

    const item = document.createElement('button');
    item.className =
      'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-edge/60 ' +
      (entry.danger ? 'text-danger' : 'text-fg');

    const icon = document.createElement('span');
    icon.className = 'shrink-0 flex items-center w-4 text-muted';
    if (entry.icon) icon.innerHTML = `<iconify-icon icon="${entry.icon}"></iconify-icon>`;

    const label = document.createElement('span');
    label.className = 'flex-1';
    label.textContent = entry.label;

    item.append(icon, label);
    item.addEventListener('click', () => {
      closeContextMenu();
      entry.onSelect();
    });
    menu.appendChild(item);
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
