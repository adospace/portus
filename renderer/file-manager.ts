// Helpers for revealing a folder in the OS file manager. Shared by the folder
// tree's right-click menu, the tab context menu, and the session-history rows.
const ICON = 'lucide:folder-open';

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
