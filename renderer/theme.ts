// Applies the user's color-scheme choice. "system" resolves to light/dark via
// the OS preference (and tracks live changes); "light"/"dark" force it. The
// resolved scheme is written as data-theme on <html>, where styles.css overrides
// the --color-* tokens for light — re-theming every Tailwind utility at once.
//
// The choice is mirrored to localStorage so the very first paint on the next
// launch matches the user's pick without waiting for the async settings load
// (which then confirms it). onResolved lets non-CSS consumers (xterm terminals,
// which read colors once) re-theme when the scheme flips.
import type { ThemeChoice } from '../electron/ipc';

const STORAGE_KEY = 'portus.theme';

export type ResolvedTheme = 'light' | 'dark';

function isChoice(v: unknown): v is ThemeChoice {
  return v === 'system' || v === 'light' || v === 'dark';
}

export class ThemeManager {
  private choice: ThemeChoice = 'system';
  private readonly lightMql = window.matchMedia('(prefers-color-scheme: light)');

  constructor(private readonly onResolved: (resolved: ResolvedTheme) => void) {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (isChoice(cached)) this.choice = cached;
    // Re-resolve when the OS scheme flips, but only while following the system.
    this.lightMql.addEventListener('change', () => {
      if (this.choice === 'system') this.applyResolved();
    });
    this.applyResolved();
  }

  get current(): ThemeChoice {
    return this.choice;
  }

  /** Switch the active theme and persist the choice to localStorage. */
  set(choice: ThemeChoice): void {
    this.choice = choice;
    localStorage.setItem(STORAGE_KEY, choice);
    this.applyResolved();
  }

  private resolve(): ResolvedTheme {
    if (this.choice === 'system') return this.lightMql.matches ? 'light' : 'dark';
    return this.choice;
  }

  private applyResolved(): void {
    const resolved = this.resolve();
    document.documentElement.dataset['theme'] = resolved;
    this.onResolved(resolved);
  }
}
