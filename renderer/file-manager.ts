// Helpers for revealing a folder in the OS file manager and copying its path.
// Shared by the folder tree's right-click menu, the tab context menu, and the
// session-history rows.
const ICON = 'lucide:folder-open';
const COPY_ICON = 'lucide:copy';

/** Platform-appropriate label for the "open folder in the OS file manager" action. */
export function fileManagerLabel(): string {
  switch (window.api.platform) {
    case 'darwin':
      return 'Reveal in Finder';
    case 'win32':
      return 'Open in File Explorer';
    default:
      return 'Open folder';
  }
}

/** A ready-made context-menu action entry for opening `folder` in the file manager. */
export function revealAction(folder: string): { icon: string; label: string; onSelect: () => void } {
  return { icon: ICON, label: fileManagerLabel(), onSelect: () => openInFileManager(folder) };
}

export function openInFileManager(folder: string): void {
  void window.api.shell.openPath(folder);
}

/** Label for the "copy folder path to clipboard" action. */
export const copyPathLabel = 'Copy folder path';

/** Label for the file variant of the copy-path action (right-clicking a file row). */
export const copyFilePathLabel = 'Copy file path';

/** A ready-made context-menu action entry for copying `target` to the clipboard.
 *  Pass `copyFilePathLabel` for file rows so the menu reads "Copy file path". */
export function copyPathAction(
  target: string,
  label: string = copyPathLabel,
): { icon: string; label: string; onSelect: () => void } {
  return { icon: COPY_ICON, label, onSelect: () => copyPath(target) };
}

export function copyPath(folder: string): void {
  window.api.clipboard.writeText(folder);
}

/** Platform-appropriate label for the "move to OS trash" action. */
export function trashLabel(): string {
  return window.api.platform === 'win32' ? 'Move to Recycle Bin' : 'Move to Trash';
}
