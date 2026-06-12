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
- **At-a-glance status.** Every tab shows whether its agent is *busy* (●, pulsing),
  *idle* (◌), or *done* (✓), plus a live elapsed timer while it's working — so you
  know which sessions need attention without clicking into them.
- **Start sessions where the work is.** The left pane is a lazy folder tree rooted
  at a drive/volume you pick from a selector (Windows drive letters, macOS volumes);
  right-click any directory to launch an agent there.
- **Persistence + cost tracking.** Sessions (folder, agent session id) survive app
  restarts, and token usage is accumulated into a running USD cost per session,
  shown in the status bar and the session-history pane.

The three panes are: **folder tree** (left) → **terminal tabs + status bar**
(center) → **session history** (right). See `## UI Layout` below for the sketch.

## Architecture

### Two-process model
- **Electron shell** — UI, xterm.js terminal emulation, node-pty PTY management. The
  main process is the sole broker: the renderer reaches privileged work only through
  the `window.api` contextBridge (`electron/preload.ts`), never node-pty or the
  socket directly.
- **.NET sidecar** — session persistence, usage tracking, and cost aggregation
  (SQLite via EF Core). Auto-started as a child process by Electron and spoken to
  over a named pipe (Windows) / Unix domain socket (macOS) with newline-delimited
  JSON. (Published self-contained single-file, not AOT — see Build & Run.)

### Tech stack
- Electron (latest stable)
- TypeScript (strict mode, ESNext target)
- xterm.js + xterm-addon-fit + xterm-addon-web-links
- node-pty (ConPTY on Windows, unix-pty on Mac)
- Tailwind CSS v4 (CSS-first config, no tailwind.config.js)
- Iconify with Lucide icon set (`@iconify/iconify` + `lucide` collection)
- npm (no yarn/pnpm)
- .NET 10 AOT sidecar (C# 14, named pipe server, EF Core + SQLite)

## UI Layout

```
┌─────────────┬──────────────────────────────┬─────────────────┐
│ Folder Tree │        Terminal Tabs          │ Session History │
│             │  [● proj-a] [◌ proj-b] [+]   │                 │
│  ~/dev      │ ┌──────────────────────────┐ │ proj-a  14:32   │
│  ├ proj-a   │ │                          │ │ proj-b  13:10   │
│  ├ proj-b   │ │   xterm.js canvas        │ │ ...             │
│  └ proj-c   │ │                          │ │                 │
│             │ └──────────────────────────┘ │                 │
│             │  📁 ~/dev/proj-a  $0.042     │                 │
└─────────────┴──────────────────────────────┴─────────────────┘
```

**Left pane** — drive/volume selector (header) + folder tree (fs.readdir, lazy-loaded) rooted at the selected drive; defaults to the drive holding the user's home folder; right-click → "New session here"
**Center pane** — tabbed xterm.js terminals, tab shows: busy indicator (● animated / ◌ idle), folder name, elapsed time when busy
**Right pane** — session list (current + past), click to restore, shows folder + timestamp
**Bottom bar** — active tab: working folder, context-window used, elapsed (right)

## Core Features (v1)

### Session lifecycle
- Spawn `claude` via node-pty from the target folder
- Detect idle vs busy by parsing PTY output for Claude's prompt string (`✦` or `>`)
- On app close: serialize all open sessions (folder, claude session ID from `--resume`) to sidecar
- On app start: restore sessions, re-attach via `claude --resume <id>`

### Session persistence
- Sidecar owns a SQLite DB: sessions table (id, folder, claude_session_id, created_at, last_active, total_tokens, total_cost)
- Electron calls sidecar over named pipe for read/write
- Sidecar auto-starts as child process on Electron startup

### Usage tracking
- Parse PTY output for Claude's end-of-turn usage summary (tokens in/out)
- Accumulate per session, display in bottom bar and session list
- Cost calculation: use current Claude pricing constants (configurable)

### Busy state detection
- Tab indicator: ● (orange, pulsing) = busy, ◌ = idle, ✓ = completed (on PTY exit)
- **As implemented** (`pty-manager.ts`): a cadence heuristic — any output marks the
  session `busy`; after `IDLE_AFTER_MS` (700ms) of silence it flips to `idle`. This
  sidesteps the brittle prompt-string parsing in the original design; swap in
  prompt-marker detection (`✦`/`>`) here if it proves more reliable.

### Context-window gauge
- **What.** A per-tab "heaviness" indicator: how full the session's context window
  is, so you know when to `/compact` or start fresh. A thin fill bar along the bottom
  of each terminal tab (green → amber ≥80% → red ≥95%) plus a `% ctx` segment in the
  status bar for the active tab; the tab's tooltip shows `tokens / limit`.
- **Source.** The main process reads the session's Claude Code transcript
  (`~/.claude/projects/<encoded-cwd>/<newest>.jsonl`, mapped by folder via
  `context.get`), takes the latest assistant entry's `usage`, and sums
  `input + cache_creation + cache_read` tokens ≈ current context occupancy. Only a
  tail of the file is read. Limit defaults to 200k, bumped to 1M when occupancy
  exceeds 200k (the 1M-context variants aren't distinguishable by model id). The
  renderer polls every 4s (`PaneManager.refreshContext`). No transcript → no gauge.
- **Caveat.** Mapping is by folder + newest transcript, so two live sessions in the
  same folder share a reading until per-session Claude ids are captured.

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
│   ├── pty-manager.ts    # node-pty session management + busy/idle detection
│   ├── sidecar.ts        # spawns + talks to the .NET sidecar over the pipe
│   ├── ipc.ts            # shared channel names + payload types (main/preload/renderer)
│   └── preload.ts        # contextBridge → window.api
├── renderer/
│   ├── index.html        # custom title bar + resizable 3-pane shell + #layout-grid
│   ├── app.ts            # thin bootstrap: builds managers, outer splitters, event routing
│   ├── pane.ts           # Pane: one self-contained tab group (tab bar + terminal stack)
│   ├── pane-manager.ts   # owns Pane[], active pane, ptyId→Pane routing, sessions, status bar
│   ├── layout.ts         # LayoutManager: single/quad/six grids + inner gutters
│   ├── splitter.ts       # reusable drag-to-resize gutter (outer panes + inner layout)
│   ├── titlebar.ts       # custom window chrome: File▸{Settings,Exit}, gear btn, layout selector, win controls
│   ├── terminal-tab.ts   # xterm.js wrapper (fit + web-links + WebGL addons; reparent)
│   ├── folder-tree.ts    # left pane: drive/volume selector + lazy dir tree (fs.drives)
│   ├── session-list.ts   # right pane
│   ├── settings-store.ts # in-memory holder for user settings (loads/saves via window.api.settings)
│   ├── settings-view.ts  # Settings tab content: left nav + section editors (Commands)
│   ├── command-menu.ts   # shared popup listing launch commands (+ button & folder-tree menu)
│   ├── global.d.ts       # ambient window.api type + lucide json module decl
│   └── styles.css        # Tailwind v4 entry (@import "tailwindcss")
├── scripts/
│   ├── build.mjs         # esbuild: bundles main/preload/renderer + copies html
│   ├── start.mjs         # launches Electron with NODE_OPTIONS sanitized
│   └── test-sidecar.mjs  # headless smoke test of the pipe protocol
├── sidecar/              # .NET 10 project
│   ├── Program.cs        # entry + command dispatch
│   ├── SessionStore.cs   # EF Core + SQLite (Session entity, DbContext, CRUD)
│   ├── PipeServer.cs     # NDJSON over named pipe (win) / Unix socket (mac)
│   └── UsageTracker.cs
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
- **Pane model.** The center is one or more **panes**, each a self-contained tab group
  (`pane.ts`: own tab bar + `+` button + terminal stack + active tab). `PaneManager`
  (`pane-manager.ts`) owns the `Pane[]`, the single globally **active pane** (new
  sessions / folder-tree right-click / history restore all target it), a
  `ptyId→Pane` index for routing PTY events, and the one global status bar. It is the
  **sole caller** of `window.api.pty.*`; panes delegate spawn/kill/resize + status
  painting back through callbacks.
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
- Icons via Iconify runtime (`@iconify/iconify`) with Lucide collection — e.g. `<span class="iconify" data-icon="lucide:terminal"></span>`
- **Iconify replaces the placeholder node.** At render time Iconify swaps each
  `.iconify` `<span>` for a fresh `<svg>` (`replaceChild`), so any click listener or
  later `dataset.icon =` write on the original span is silently lost. For anything
  dynamic or clickable, keep a **stable wrapper** element and set its icon via the
  `setIcon(wrapper, name)` helper (`pane.ts`, `folder-tree.ts`, `titlebar.ts` — writes
  a new inner placeholder the observer renders); put listeners and transforms on the wrapper.
- .NET sidecar: C# 14, minimal APIs pattern for the pipe protocol, no over-engineering
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

## IPC Protocol (Electron ↔ Sidecar)
Newline-delimited JSON over a named pipe (`\\.\pipe\portus`) on Windows / Unix
domain socket (`/tmp/portus.sock`) on macOS. Each request carries an `id` so the
client can correlate the response; the sidecar echoes it back in an envelope.
Channel names + payload types live in `electron/ipc.ts`; the sidecar mirrors them
in `Program.cs`'s `Dispatch`.
```json
// request → response
{ "id": 1, "cmd": "session.save",   "data": { "id":"…","folder":"…","claudeId":null,"title":null,"createdAt":"…","lastActive":"…","totalTokens":0,"totalCost":0 } }
{ "id": 2, "cmd": "session.list",   "data": {} }
{ "id": 3, "cmd": "session.get",    "data": { "id": "…" } }
{ "id": 4, "cmd": "session.delete", "data": { "id": "…" } }
{ "id": 5, "cmd": "usage.add",      "data": { "sessionId":"…","tokensIn":1200,"tokensOut":340 } }
// response envelope:  { "id": 5, "ok": true, "data": <result> }  |  { "id": 5, "ok": false, "error": "…" }
```
Cost rates live in `UsageTracker` (USD per 1M tokens). The renderer↔main hop is a
separate IPC layer (Electron `ipcMain`/`contextBridge`); main brokers everything,
the renderer never touches node-pty or the socket directly. The renderer↔main
channels (incl. `fs.home`, `fs.listDir`, `fs.drives` → `Drive[]`, and `context.get`
→ `ContextUsage | null`) and their payload
types live in `electron/ipc.ts` and are exposed via `window.api` in `preload.ts` —
add new channels in all three layers (ipc/main/preload), the `global.d.ts` type
follows automatically.

## Out of Scope (v1)
- File editor or file viewer
- Git integration
- Multi-agent orchestration / message passing between sessions
- Codex support (stub the interface, implement later)
- Settings UI (use a JSON config file in app data dir)

## Build & Run
```bash
npm install             # node-pty ships N-API prebuilds — NO native rebuild needed (see note)
npm run sidecar:build   # publish the .NET sidecar exe → dist/sidecar/ (run once, or after C# changes)
npm start               # build:bundle + build:css, then launch Electron via scripts/start.mjs
```
Other scripts: `npm run typecheck` (tsc, strict, no emit), `npm run build`
(esbuild bundle + Tailwind CSS only), `npm run test:sidecar` (headless pipe-protocol
smoke test), `npm run sidecar:build:mac` (osx-arm64 publish).

### Build pipeline
- **TypeScript** is bundled by **esbuild** (`scripts/build.mjs`), not `tsc` — three
  entry points: `electron/main.ts` + `electron/preload.ts` (CJS, node platform,
  `electron`/`node-pty` marked external) and `renderer/app.ts` (IIFE, browser).
  `tsc` is type-check-only. Output → `dist/`.
- **Tailwind v4** is compiled by `@tailwindcss/cli` → `dist/renderer/styles.css`.
  xterm's own CSS is imported in `terminal-tab.ts` and emitted by esbuild as
  `dist/renderer/app.css`. `index.html` links both.
- **Lucide** icons are bundled offline: `@iconify-json/lucide/icons.json` is loaded
  via `Iconify.addCollection()` in `app.ts` (no network/API calls at runtime).

### Two implementation notes (deviations from the original spec)
- **node-pty needs no `electron-rebuild`.** v1.1.0 is N-API (`node-addon-api`) and
  ships prebuilt binaries for win32-x64/arm64 + darwin; N-API is ABI-stable across
  Node and Electron, so the prebuilds load directly. (There is no C++ toolchain on
  the dev machine anyway — compiling from source would fail.)
- **Sidecar is self-contained single-file, NOT NativeAOT.** EF Core's SQLite provider
  does not trim/AOT cleanly; `sidecar:build` publishes `--self-contained
  -p:PublishSingleFile=true`. Revisit AOT only if you drop EF Core for raw
  `Microsoft.Data.Sqlite`. The csproj sets `IncludeNativeLibrariesForSelfExtract=true`
  so `e_sqlite3.dll` is embedded in the exe and self-extracts at runtime — **do not
  remove it**: without it the native lib sits loose beside the exe and a
  `DllNotFoundException` (SQLitePCL `Batteries_V2.Init`) follows the moment the two
  get separated (e.g. `npm run clean`, packaging, or copying just the exe).
- `scripts/start.mjs` strips `--openssl-legacy-provider` from `NODE_OPTIONS` before
  spawning Electron (some dev machines set it globally; Electron refuses to start
  with it).

### Packaging & Release
- **electron-builder** (`electron-builder.yml`) packages distributables: a Windows
  NSIS installer (`portus-Setup-<version>.exe`) and a macOS `dmg`+`zip` (arm64).
  Local builds: `npm run dist:win` / `npm run dist:mac` (each runs `build` +
  the matching `sidecar:build*` first); output → `release/`.
- Two config choices are load-bearing, **do not flip them**:
  - `asar: false` — `sidecar.ts` resolves the sidecar exe via
    `app.getAppPath()+'/dist/sidecar/…'` and `spawn`s it; node-pty is a native addon.
    Both must be real on-disk files, not asar entries.
  - `npmRebuild: false` — node-pty's N-API prebuilds are ABI-stable across Electron,
    so no rebuild is needed (and the design assumes none).
- electron-builder auto-collects the **production** dependency tree from
  `node_modules` (node-pty); dev deps are excluded. The platform-correct sidecar must
  already be published into `dist/sidecar/` before electron-builder runs.
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
2. ~~Named pipe convention Windows vs Mac~~ — done: named pipe on Windows,
   `UnixDomainSocketEndPoint` on Unix (note the capital `P` in `EndPoint`).
3. Whether to use xterm-addon-serialize for tab serialization (snapshot terminal
   buffer on hide, restore on show). Currently sessions are persisted (folder + id),
   not terminal scrollback.
