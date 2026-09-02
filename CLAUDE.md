# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# portus — Agentic Terminal

## Project Overview
**portus** is a standalone cross-platform desktop app (Windows + macOS) that acts as
*mission control* for multiple AI agent CLI sessions — Claude Code today, Codex and
other CLIs later. Instead of juggling several terminal windows, you run every agent
in one focused, three-pane interface and watch them at a glance.

It is deliberately **not** an IDE: there is no code editor, no file viewer, no git
integration. The app does one thing well — spawn, track, and switch between
long-running agent terminals — and gets out of the way.

What it gives you over a plain terminal:
- **Many agents, one window.** Each session is a tab with its own real PTY (a true
  shell + agent CLI, not a fake terminal), so anything that works in your terminal
  works here.
- **At-a-glance status, straight from the agent.** A tab is labelled with the title
  its agent publishes over OSC — including the glyph Claude Code animates while it's
  thinking — so you can see which sessions are working without clicking into them.
  The app adds no indicator of its own (see `## Tab liveness` below).
- **Start sessions where the work is.** The left pane is a lazy folder tree rooted
  at a drive/volume you pick from a selector (Windows drive letters, macOS volumes);
  right-click any directory to launch an agent there.
- **Persistence + cost tracking.** Sessions (folder, agent session id) survive app
  restarts, and token usage is accumulated into a running USD cost per session,
  shown in the status bar and the session-history pane.

The three panes are: **folder tree** (left) → **terminal tabs + status bar**
(center) → **session history** (right). See `## UI Layout` below for the sketch.

## Architecture

### Single-process model
A single Electron app — no sidecar, no second runtime. The **main process** is the
sole broker: UI window, xterm.js terminal emulation, node-pty PTY management, **and**
session persistence. The renderer reaches privileged work only through the
`window.api` contextBridge (`electron/preload.ts`), never node-pty or the filesystem
directly. Sessions, usage, and cost totals are persisted **in-process** as a small
JSON file (`sessions.json`) in the per-user app data dir — see `electron/session-store.ts`.

> Historical note: persistence used to live in a separate **.NET sidecar** (SQLite +
> EF Core) spoken to over a named pipe. That was removed — the dataset is a handful
> of session rows, so a JSON file in the main process does the same job without a
> second language, runtime, IPC layer, or the packaging footguns it carried.

### Tech stack
- Electron (latest stable)
- TypeScript (strict mode, ESNext target)
- xterm.js + xterm-addon-fit + xterm-addon-web-links
- node-pty (ConPTY on Windows, unix-pty on Mac)
- Tailwind CSS v4 (CSS-first config, no tailwind.config.js)
- Iconify with Lucide icon set (`iconify-icon` web component + `@iconify-json/lucide` collection)
- npm (no yarn/pnpm)
- Session persistence: in-process JSON store (`electron/session-store.ts`), no database

## UI Layout

```
┌─────────────┬──────────────────────────────┬─────────────────┐
│ Folder Tree │        Terminal Tabs          │ Session History │
│             │  [✳ proj-a] [proj-b] [+]     │                 │
│  ~/dev      │ ┌──────────────────────────┐ │ proj-a  14:32   │
│  ├ proj-a   │ │                          │ │ proj-b  13:10   │
│  ├ proj-b   │ │   xterm.js canvas        │ │ ...             │
│  └ proj-c   │ │                          │ │                 │
│             │ └──────────────────────────┘ │                 │
│             │  📁 ~/dev/proj-a  $0.042     │                 │
└─────────────┴──────────────────────────────┴─────────────────┘
```

**Left pane** — drive/volume selector (header) + folder tree (fs.readdir, lazy-loaded) rooted at the selected drive; defaults to the drive holding the user's home folder; right-click → "New session here". Dot-prefixed entries are hidden only on macOS/Linux, where the dot *is* the hidden convention; on Windows (`fs:listDir` in `main.ts`) `.certs`/`.github`/`.claude` are listed like any other folder. Clicking a directory **selects** it (persistent gray row tint) and reports the selection so the session list can mark same-folder rows with a gray edge line.
**Center pane** — tabbed xterm.js terminals; a tab shows the agent's own OSC title (falling back to the folder name) plus the context-fill bar along its bottom edge — nothing else, so its width never changes while the session runs
**Right pane** — session list (current + past), **shown on demand** — collapsed/restored by the title-bar toggle (see `## Window chrome` below), remembered across restarts; click a row to restore a session, shows folder + timestamp; each row can show two left-edge folder-match lines: **gray** = same folder as the one selected in the tree, **orange** = same folder as the active tab (so same-folder sessions stand out)
**Bottom bar** — active tab: working folder, git branch, working-tree changes, context-window used (right)

## Core Features (v1)

### Session lifecycle
- Spawn `claude` via node-pty from the target folder
- On app close: serialize all open sessions (folder, claude session ID from `--resume`) to the session store
- On app start: restore sessions, re-attach via `claude --resume <id>`

### Session persistence
- `SessionStore` (`electron/session-store.ts`) owns `sessions.json` in `app.getPath('userData')`:
  one record per session (id, folder, claudeId, title, createdAt, lastActive, totalTokens, totalCost)
- Loaded into an in-memory Map on startup; every mutation rewrites the file atomically
  (temp-file + rename). Reads (`list`/`get`) serve from memory; search is plain array filtering
- The renderer reaches it through `window.api.sessions.*` / `usage.add` → main-process IPC handlers

### Usage tracking
- Parse PTY output for Claude's end-of-turn usage summary (tokens in/out)
- Accumulate per session, display in bottom bar and session list
- Cost calculation: use current Claude pricing constants (configurable)

### Tab liveness (replaces the old busy/idle tracker)
- **The app tracks no activity state of its own.** There is no busy/idle/done dot,
  no elapsed timer on the tab, and no elapsed segment in the status bar. The
  previous cadence heuristic (any output → `busy`, 700ms of silence → `idle`)
  flapped constantly against an agent CLI that redraws a spinner: the dot and the
  timer appeared and vanished every second, and because both changed the tab's
  width, the whole tab bar visibly jittered. Don't reintroduce a
  variable-width element in the tab button.
- **What signals liveness instead:** the agent's own window title. Claude Code
  publishes its state over OSC 0/2 and animates a glyph in it while it works, so
  the tab label *is* the activity indicator — with no guesswork on our side.
- **Where it's parsed:** `pty-manager.ts` (`takeTitle`), off the raw PTY stream in
  the main process, emitted as `pty:title` → `PaneManager.routeTitle`. Deliberately
  **not** `xterm.onTitleChange`: xterm only surfaces the title after the written
  bytes drain through its internal write buffer, which is renderer-scheduled work,
  so a hidden tab's label lagged or stalled behind the focused one. Parsing in main
  makes background tabs track their agent identically to the focused tab.
  `takeTitle` carries a partial escape sequence across chunk boundaries and reports
  only the last title per flush, so an animation burst collapses to one IPC message.
- **Focus spoofing keeps background titles animating.** Claude Code enables focus
  reporting (DECSET 1004) and **pauses its title animation while the terminal
  reports focus-out** — and it assumes unfocused until the first focus-in arrives.
  Untreated, that froze every deselected tab's glyph (its xterm blurs when another
  tab takes DOM focus) and background-spawned sessions never animated at all. So
  every tab plays "always focused": `terminal-tab.ts` swallows xterm's real
  CSI I/O focus reports before they reach the PTY, and `pty-manager.ts` answers
  each `ESC[?1004h` in the output stream with a synthetic focus-in (CSI I).
  Tradeoff: an agent can never tell its tab is backgrounded (e.g. unfocused-only
  bell/notification behavior won't trigger) — accepted, since the animated title
  across all tabs *is* the app's core at-a-glance signal.
- **Persistence is throttled** (`TITLE_PERSIST_MS`, 3s): the tab label follows every
  animation frame (a text write), but writing to the session store must not — each
  save rewrites `sessions.json` and rebuilds the history pane.
- On PTY exit the tab label just dims (`Pane.markExited`) — a static marker, not an
  animation.

### Context-window gauge
- **What.** A per-tab "heaviness" indicator: how full the session's context window
  is, so you know when to `/compact` or start fresh. A thin fill bar along the bottom
  of each terminal tab (green → amber ≥80% → red ≥95%) plus a `% ctx` segment in the
  status bar for the active tab; the tab's tooltip shows `tokens / limit`.
- **Source.** The main process reads the session's Claude Code transcript
  (`~/.claude/projects/<encoded-cwd>/<newest>.jsonl`, mapped by folder via
  `context.get`), takes the latest assistant entry's `usage`, and sums
  `input + cache_creation + cache_read` tokens ≈ current context occupancy. Only a
  tail of the file is read. The limit (denominator) is derived from the transcript's
  model id in `contextLimitFor`: current 1M-window models — Opus 4.6/4.7/4.8,
  Sonnet 4.6, Fable/Mythos 5 — get 1M; Haiku and the older 4.0/4.1/4.5 families
  (200k base, 1M only via an opt-in beta we can't see) and unknown ids default to
  200k, with a safety net that bumps the denominator if occupancy ever exceeds the
  assumed limit. The renderer polls every 4s (`PaneManager.refreshContext`). No
  transcript → no gauge.
- **Freshness.** `context.get(folder, since)` ignores transcripts last modified
  before `since` (the tab's `startedAt`), so a **new** session never inherits a
  prior run's leftover transcript in the same folder — and a plain shell (which
  writes no transcript) shows no gauge. A resumed session's gauge stays blank until
  its first new turn touches the transcript.
- **Caveat.** Within a session's own lifetime, mapping is still by folder + newest
  transcript, so two live sessions started in the same folder can share a reading
  until per-session Claude ids are captured.

### Pinned folders
- **What.** A persistent quick-access list at the **bottom of the left pane**
  (`#pinned-panel`, hidden until non-empty). Pin a folder via **"Pin folder"** in
  the folder-tree right-click menu (`folder-tree.ts`) or a terminal tab's
  right-click menu (`pane-manager.ts` `openTabMenu`). Clicking a pinned entry opens
  the shared `command-menu.ts` popup to launch a session there (same flow as the `+`
  button); hover-× or right-click ▸ Unpin removes it.
- **Persistence.** Stored as `pinnedFolders: string[]` in `settings.json`
  (`AppSettings` in `ipc.ts`, sanitized in `main.ts` `readSettings`). The renderer's
  `PinnedFolders` (`pinned-folders.ts`) reads it via `SettingsStore.pinned()` on
  startup and writes through `SettingsStore.setPinned()` on every pin/unpin (which
  rewrites the whole settings file, preserving the other sections).

### Settings
- **Where.** Opened from the gear button (titlebar, top-right) or **File ▸ Settings**;
  both call `PaneManager.openSettings()`, which opens a single **Settings tab** in the
  active ("first available") pane — or just focuses it if one already exists.
- **Settings tab is a non-terminal view.** A Pane tab's content is a `TabContent`
  (`pane.ts`): `TerminalTab` for real PTYs, `SettingsView` (`settings-view.ts`) for the
  Settings panel — same `show/hide/reparent/fit/dispose` surface, so the pane relocates
  it across layout changes like any tab. `Tab.kind` (`'terminal' | 'settings'`) gates the
  PTY-only paths: status-dot painting, the fit→resize call, and `pty.kill` on close all
  skip non-terminal tabs. The Settings tab uses the synthetic id `'settings'` (no PTY).
  Its UI is a left nav (section list) + right content; today one section, **Commands**.
- **Persistence.** The main process owns `settings.json` in `app.getPath('userData')`
  (`settings:get`/`settings:save` channels in `ipc.ts`); first run / unreadable file →
  `DEFAULT_SETTINGS`. The renderer's `SettingsStore` (`settings-store.ts`) caches it and
  is the live source the folder tree and the `+` menu read from.
- **Commands.** A user list of `{ name, command }` launch presets (`DEFAULT_COMMANDS` in
  `ipc.ts` seeds claude / codex / shell / build examples). They populate the shared
  `command-menu.ts` popup, shown from the folder-tree right-click **and** the pane `+`
  button (replacing the old hard-coded "New session here"). Picking one runs its command
  in a fresh console via `createSession(folder, { command })`; an empty command (`''`)
  means a plain shell (`pty-manager` skips the startup write).

## File Structure

```
/
├── electron/
│   ├── main.ts           # Electron main process: window, IPC broker, lifecycle
│   ├── pty-manager.ts    # node-pty session management + OSC window-title extraction
│   ├── session-store.ts  # in-process JSON session persistence + cost rates (replaces the sidecar)
│   ├── ipc.ts            # shared channel names + payload types (main/preload/renderer)
│   └── preload.ts        # contextBridge → window.api
├── renderer/
│   ├── index.html        # custom title bar + resizable 3-pane shell + #layout-grid
│   ├── app.ts            # thin bootstrap: builds managers, outer splitters, event routing
│   ├── pane.ts           # Pane: one self-contained tab group (tab bar + terminal stack)
│   ├── pane-manager.ts   # owns Pane[], active pane, ptyId→Pane routing, sessions, status bar
│   ├── layout.ts         # LayoutManager: single/quad/six grids + inner gutters
│   ├── splitter.ts       # reusable drag-to-resize gutter (outer panes + inner layout)
│   ├── titlebar.ts       # custom window chrome: File▸{Settings,Exit}, sessions toggle, layout selector, gear btn, win controls
│   ├── terminal-tab.ts   # xterm.js wrapper (fit + web-links + WebGL addons; reparent)
│   ├── folder-tree.ts    # left pane: drive/volume selector + lazy dir tree (fs.drives)
│   ├── pinned-folders.ts # left pane (bottom): persistent pinned-folder quick-launch list
│   ├── session-list.ts   # right pane
│   ├── settings-store.ts # in-memory holder for user settings (loads/saves via window.api.settings)
│   ├── settings-view.ts  # Settings tab content: left nav + section editors (General, Commands)
│   ├── command-menu.ts   # shared popup listing launch commands (+ button & folder-tree menu)
│   ├── context-menu.ts   # generic icon+label context menu (tab right-click actions)
│   ├── file-manager.ts   # shared "open folder in OS file manager" label + action (shell.openPath)
│   ├── theme.ts          # ThemeManager: system/light/dark resolution + <html> data-theme
│   ├── global.d.ts       # ambient window.api type + lucide json module decl
│   └── styles.css        # Tailwind v4 entry (@import "tailwindcss") + light-theme tokens
├── scripts/
│   ├── build.mjs         # esbuild: bundles main/preload/renderer + copies html + icon
│   ├── make-icon.mjs     # renders build/icon.png from the Lucide ship glyph (no image deps)
│   └── start.mjs         # launches Electron with NODE_OPTIONS sanitized
├── build/
│   └── icon.png          # app icon (1024², generated by make-icon.mjs); electron-builder source
├── .github/workflows/
│   └── release.yml       # CI: on v* tag → build win+mac, publish to GitHub Releases
├── electron-builder.yml  # packaging: NSIS (win) + dmg/zip (mac); asar:false, npmRebuild:false
├── tsconfig.json
├── CLAUDE.md             # this file
└── package.json
```

## Window chrome & multi-pane layouts
- **Frameless custom chrome.** The window is `frame: false` (`main.ts`). Windows/Linux
  draw their own minimize/maximize/close (top-right of `#titlebar`); macOS keeps native
  traffic lights via `titleBarStyle: 'hiddenInset'` and `titlebar.ts` hides the custom
  controls + pads the left. Drag is `-webkit-app-region: drag` on `#titlebar`, with
  `no-drag` on every interactive cluster. Window controls go over IPC
  (`win:minimize`/`win:maximizeToggle`/`win:close`/`win:isMaximized`/
  `win:maximizedChanged`, `app:quit`). The renderer reads `window.api.platform`.
- **Sessions-pane toggle.** `#toggle-sessions` (Lucide `history`, same glyph as the
  pane's own header) sits in the right cluster just left of the layout selector,
  separated by a `mr-3` gap; it highlights (`bg-edge`/`text-fg`) while the pane is
  shown, exactly like the active layout button. `TitleBar` owns only the button
  state — `app.ts`'s `applySessionsVisible` does the work: it toggles
  `#shell.sessions-hidden`, hides the aside + its splitter, and calls `refitAll()`
  so the terminals pick up the wider center. The collapse is a **CSS class on
  `#shell`**, which is why `grid-template-columns` lives in `styles.css` and not in
  an inline style — an inline template would outrank the class. `--col-right` is
  deliberately left untouched so the user's dragged width returns on re-show. The
  choice persists as `general.showSessions` in `settings.json` (written on each
  toggle via `SettingsStore.setShowSessions`, applied in `init()` after settings
  load — the Settings form is not the editor for it, so its General save reads the
  live value rather than its own snapshot).
- **Pane model.** The center is one or more **panes**, each a self-contained tab group
  (`pane.ts`: own tab bar + `+` button + terminal stack + active tab). `PaneManager`
  (`pane-manager.ts`) owns the `Pane[]`, the single globally **active pane** (new
  sessions / folder-tree right-click / history restore all target it), a
  `ptyId→Pane` index for routing PTY events, and the one global status bar. It is the
  **sole caller** of `window.api.pty.*`; panes delegate spawn/kill/resize + status
  painting back through callbacks.
- **Closing a tab lands on the previous one, not the first.** Each `Pane` keeps a
  most-recently-activated list (`recent`, maintained by `activateTab`, pruned by
  `removeTab`/`releaseTab`). `nextTabId()` is the single fallback rule — closing the
  active tab, moving a tab out of a pane, and shrinking the layout all use it — so
  you always return to where you came from (browser-style), with the leftmost tab
  only as a last resort (e.g. an adopted tab that was never shown).
- **Layouts.** `LayoutManager` (`layout.ts`) builds `#layout-grid` for `single` (1),
  `quad` (2×2 = 4), `six` (3×2 = 6). Switching **grows** (adds empty panes) or
  **shrinks** (relocates orphaned tabs into the last surviving pane via
  `releaseTab`/`adoptTab` + `TerminalTab.reparent`, then updates `ptyIndex` — never
  killing a session). Layout state is **in-memory only**; the app always boots in
  `single` (cross-restart persistence waits for the user-preferences system).
- **Splitters.** `splitter.ts` is one reusable drag gutter used for BOTH the outer
  3-pane columns (`#shell` CSS vars `--col-left`/`--col-right`) and the inner layout
  gutters (`--quad-*`, `--six-*`). It resizes CSS grid tracks via get/set closures;
  `body.resizing .term-host { pointer-events: none }` lets drags pass over xterm's
  canvas. The active pane gets an accent ring (`.pane-active`, multi-pane only).

## Coding Rules
- TypeScript strict mode throughout — main process, preload, and renderer
- No React/Vue/Angular/Svelte — vanilla TypeScript + DOM, keep it lean
- Tailwind v4 — CSS-first, use `@import "tailwindcss"` in styles.css, no config file, custom tokens via `@theme`
- Icons via the **`iconify-icon` web component** with the Lucide collection — e.g.
  `<iconify-icon icon="lucide:terminal"></iconify-icon>`. The element renders itself
  (no `scan()` step) and re-renders when its `icon` attribute changes, including nodes
  added later. The collection is registered offline in `app.ts`
  (`addCollection(lucide)` from `iconify-icon`), so there are no network/API calls.
- **Stable-wrapper `setIcon` is still used for dynamic icons.** Unlike the old
  `@iconify/iconify` runtime (which swapped the placeholder `<span>` for an `<svg>`),
  `iconify-icon` elements are stable — but the `setIcon(wrapper, name)` helper
  (`pane.ts`, `folder-tree.ts`, `titlebar.ts`) is retained so listeners/transforms live
  on the wrapper (e.g. the rotating folder chevron, the max/restore glyph). It now
  writes an inner `<iconify-icon>` rather than a placeholder span.
- xterm.js: always use WebGL renderer addon for performance. `fontFamily` must be a
  **concrete font stack**, not a CSS `var(...)` — xterm renders to canvas/WebGL and
  can't resolve CSS variables; `terminal-tab.ts` reads `--font-mono` via
  `getComputedStyle` and passes the resolved string.
- Side-pane scrollbars: add the `scroll-area` class (themed, auto-hides until hover);
  the tab bar uses `tab-scroll` + `overflow-y-hidden` (its `overflow-x-auto` would
  otherwise force a stray vertical scrollbar). Both defined in `styles.css`.
- node-pty: spawn with `TERM=xterm-256color`, inherit shell env
- Never hard-code paths — all folder references relative or from user config
- npm only — no yarn, no pnpm

## IPC Protocol (renderer ↔ main)
There is only one IPC layer now: Electron `ipcMain`/`contextBridge`. The main
process brokers everything; the renderer never touches node-pty or the filesystem
directly. Session persistence is an in-process call into `SessionStore`
(`electron/session-store.ts`) — no pipe, no envelope, no request ids.

The renderer↔main channels (incl. `sessions.list/save/get/delete`, `usage.add`,
`fs.home`, `fs.listDir`, `fs.drives` → `Drive[]`, and `context.get` →
`ContextUsage | null`) and their payload types live in `electron/ipc.ts` and are
exposed via `window.api` in `preload.ts` — add new channels in all three layers
(ipc/main/preload), the `global.d.ts` type follows automatically.

Cost rates (USD per 1M tokens) live in `session-store.ts` (`INPUT_RATE_PER_MILLION`
/ `OUTPUT_RATE_PER_MILLION`); `addUsage` applies the delta and recomputes the running
cost. `save` patches an existing row but only overwrites token/cost totals when the
incoming values are > 0, so a plain title/folder re-save never clobbers usage.

## Out of Scope (v1)
- File editor or file viewer
- Git integration
- Multi-agent orchestration / message passing between sessions
- Codex support (stub the interface, implement later)
- Settings UI (use a JSON config file in app data dir)

## Build & Run
```bash
npm install   # node-pty ships N-API prebuilds — NO native rebuild needed (see note)
npm start     # build:bundle + build:css, then launch Electron via scripts/start.mjs
```
Other scripts: `npm run typecheck` (tsc, strict, no emit), `npm run build`
(esbuild bundle + Tailwind CSS only), `npm run icon` (regenerate `build/icon.png`
from the Lucide ship glyph — only needed when the glyph or accent color changes).
No sidecar build step — persistence is in-process TypeScript.

### App icon
- A single mark — the Lucide **ship** glyph on the accent rounded square — is the
  whole app's identity: the title-bar icon, the favicon, the BrowserWindow icon, and
  the packaged installer icon. `scripts/make-icon.mjs` renders `build/icon.png`
  (1024²) with **no image dependencies** (it flattens the SVG path and stroke-fills it
  via a distance field, then encodes PNG through `node:zlib`). `build.mjs` copies that
  into `dist/renderer/icon.png` for the live window icon/favicon; electron-builder
  reads `build/icon.png` as its packaging source and derives `.ico`/`.icns` from it.

### Build pipeline
- **TypeScript** is bundled by **esbuild** (`scripts/build.mjs`), not `tsc` — three
  entry points: `electron/main.ts` + `electron/preload.ts` (CJS, node platform,
  `electron`/`node-pty` marked external) and `renderer/app.ts` (IIFE, browser).
  `tsc` is type-check-only. Output → `dist/`.
- **Tailwind v4** is compiled by `@tailwindcss/cli` → `dist/renderer/styles.css`.
  xterm's own CSS is imported in `terminal-tab.ts` and emitted by esbuild as
  `dist/renderer/app.css`. `index.html` links both.
- **Lucide** icons are bundled offline: `@iconify-json/lucide/icons.json` is loaded
  via `addCollection()` (from `iconify-icon`) in `app.ts` (no network/API calls at runtime).

### Two implementation notes (deviations from the original spec)
- **node-pty needs no `electron-rebuild`.** v1.1.0 is N-API (`node-addon-api`) and
  ships prebuilt binaries for win32-x64/arm64 + darwin; N-API is ABI-stable across
  Node and Electron, so the prebuilds load directly. (There is no C++ toolchain on
  the dev machine anyway — compiling from source would fail.) **This is why
  persistence is a JSON file and not `better-sqlite3`:** better-sqlite3 isn't
  N-API/ABI-stable, so it would force `electron-rebuild` and break this guarantee.
  The session dataset is tiny, so a JSON file is the honest fit — revisit
  `node:sqlite` (built into a new enough Electron Node) only if the data ever grows.
- **Persistence is in-process, no second runtime.** `electron/session-store.ts` loads
  `sessions.json` (in `userData`) into a Map and rewrites it atomically on each
  mutation. The original design's .NET sidecar (SQLite + EF Core over a named pipe)
  was removed as overkill for the dataset.
- `scripts/start.mjs` strips `--openssl-legacy-provider` from `NODE_OPTIONS` before
  spawning Electron (some dev machines set it globally; Electron refuses to start
  with it).

### Packaging & Release
- **electron-builder** (`electron-builder.yml`) packages distributables: a Windows
  NSIS installer (`portus-Setup-<version>.exe`) and a macOS `dmg`+`zip` (arm64).
  Local builds: `npm run dist:win` / `npm run dist:mac` (each runs `build` first);
  output → `release/`.
- Two config choices are load-bearing, **do not flip them**:
  - `asar: false` — node-pty is a native addon loaded from disk; its `.node` binary
    must be a real on-disk file, not an asar entry.
  - `npmRebuild: false` — node-pty's N-API prebuilds are ABI-stable across Electron,
    so no rebuild is needed (and the design assumes none).
- electron-builder auto-collects the **production** dependency tree from
  `node_modules` (node-pty); dev deps are excluded.
- **CI release** (`.github/workflows/release.yml`): pushing a `v*` tag builds on
  `windows-latest` + `macos-latest` (matrix), publishes installers to GitHub Releases
  via `softprops/action-gh-release` (uses the auto-provided `GITHUB_TOKEN`; no secrets
  to set). Cut a release with `npm version <patch|minor|major>` then
  `git push --follow-tags` — this keeps `package.json` version (which names the
  artifacts) in sync with the release tag. macOS builds are **unsigned** (Gatekeeper
  warns); add an Apple cert + notarization if that matters.

## Open Questions for Implementation
1. Best way to detect Claude session ID from PTY output (does `claude --resume` print
   the session ID on start?). Until solved, `claudeId` is persisted as `null` and the
   PTY just launches `claude` in the folder; restore re-runs `claude --resume <id>`
   only if an id was captured. Usage parsing in `pty-manager.ts` is a tolerant
   best-effort regex — adjust once Claude's end-of-turn format is confirmed.
2. ~~Sidecar process / pipe transport~~ — removed: persistence is an in-process JSON
   store (`electron/session-store.ts`), no second process or socket.
3. Whether to use xterm-addon-serialize for tab serialization (snapshot terminal
   buffer on hide, restore on show). Currently sessions are persisted (folder + id),
   not terminal scrollback.
