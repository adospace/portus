# portus — Agentic Terminal

> Mission control for multiple AI agent CLI sessions. Run every agent in one
> focused, three-pane window and watch them all at a glance.

<img width="1400" height="900" alt="Screenshot 2026-06-13 112332" src="https://github.com/user-attachments/assets/e173a08f-b15b-48ad-ba4b-1264d5394626" />

<img width="1400" height="900" alt="Screenshot 2026-06-13 112507" src="https://github.com/user-attachments/assets/7cff1607-31e4-4452-831e-b3650a435ac2" />

<img width="1400" height="900" alt="Screenshot 2026-06-13 112608" src="https://github.com/user-attachments/assets/3095bc7a-8269-4850-b422-fa4eacca0c77" />

<img width="1400" height="900" alt="Screenshot 2026-06-13 113035" src="https://github.com/user-attachments/assets/ff2a1c8e-bc94-43db-a0be-208cc8ca273b" />


## What is portus?

**portus** is a standalone cross-platform desktop app (Windows + macOS) that acts as
mission control for multiple AI agent CLI sessions — Claude Code today, Codex and
other CLIs later. Instead of juggling several terminal windows, you run every agent
in one focused, three-pane interface.

It is deliberately **not** an IDE: there is no code editor, no file viewer, no git
integration. The app does one thing well — spawn, track, and switch between
long-running agent terminals — and gets out of the way.

### Why use it over a plain terminal

- **Many agents, one window.** Each session is a tab with its own real PTY (a true
  shell + agent CLI, not a fake terminal), so anything that works in your terminal
  works here.
- **At-a-glance status, straight from the agent.** A tab is labelled with the title
  its agent publishes — including the glyph Claude Code animates while it's thinking —
  so you can see which sessions are working without clicking into them. The app adds
  no indicator of its own, and background tabs update exactly like the focused one.
- **Start sessions where the work is.** The left pane is a lazy folder tree rooted
  at a drive/volume you pick; right-click any directory to launch an agent there or
  open it in your OS file manager. Switching tabs highlights the active session's
  folder and its parents in the tree, so you always see where you are.
- **Context-window gauge.** Each tab shows how full its session's context window is —
  a thin fill bar along the bottom edge (green → amber ≥80% → red ≥95%) plus a `% ctx`
  readout in the status bar — so you know when to `/compact` or start a fresh session.
- **Persistence.** Sessions (working folder, agent session id, title) survive app
  restarts and reappear in the session-history pane.
- **Searchable session history.** The right pane lists every session by the title the
  agent CLI generates for its task (falling back to the folder name) plus the working
  path; a search box filters by title, name, or path, and one click restores a session.
  Hover a row to open its folder in the file manager or delete it from history. The
  pane is there when you want it and gone when you don't — the ⏱ button in the title
  bar collapses it and hands the space to your terminals; the choice is remembered.
- **Flexible layouts.** Split the center into 1, 4 (2×2), or 6 (3×2) panes, each its
  own tab group, and drag the gutters to resize. Right-click a tab to relocate it
  between panes, open its folder, or close it.
- **Light & dark themes.** Follow the OS, or force light/dark — set it in
  **Settings ▸ General**, where you can also pick the default folder for new sessions
  and how long session history is kept.

```
┌─────────────┬──────────────────────────────┬─────────────────┐
│ Folder Tree │        Terminal Tabs          │ Session History │
│             │  [✳ proj-a] [proj-b] [+]     │                 │
│  ~/dev      │ ┌──────────────────────────┐ │ proj-a  14:32   │
│  ├ proj-a   │ │                          │ │ proj-b  13:10   │
│  ├ proj-b   │ │   xterm.js canvas        │ │ ...             │
│  └ proj-c   │ │                          │ │                 │
│             │ └──────────────────────────┘ │                 │
│             │  📁 ~/dev/proj-a   63% ctx   │                 │
└─────────────┴──────────────────────────────┴─────────────────┘
```

## Install

Grab the latest installer from the [**Releases**](https://github.com/adospace/portus/releases)
page.

### Windows

Download `portus-Setup-<version>.exe` and run it. The NSIS installer lets you choose
the install location and creates Start Menu / desktop shortcuts.

### macOS (Apple Silicon)

Download `portus-<version>-arm64.dmg`, open it, and drag **portus** to Applications.

> The macOS build is **not yet code-signed or notarized**, so Gatekeeper will warn
> that the app is from an unidentified developer. To open it the first time:
> right-click the app → **Open** → **Open**, or run
> `xattr -dr com.apple.quarantine /Applications/portus.app`.

> **Note:** macOS builds are Apple Silicon (arm64) only.

### Prerequisites

portus is a launcher for agent CLIs — it spawns them in a real shell. To actually use
it, you need the agent CLI installed and on your `PATH`, e.g.
[Claude Code](https://claude.com/claude-code) (`claude`).

## Build from source

Requires **Node.js 20+** and **npm**.

```bash
npm install             # node-pty ships N-API prebuilds — no native rebuild needed
npm start               # build + launch Electron
```

### Package distributables

```bash
npm run dist:win        # → release/portus-Setup-<version>.exe   (NSIS installer)
npm run dist:mac        # → release/portus-<version>-arm64.dmg + .zip
```

Each `dist:*` script builds the renderer/main bundles before running
electron-builder. Output lands in `release/`.

## Releasing

CI (`.github/workflows/release.yml`) builds Windows + macOS and publishes the
installers to GitHub Releases whenever a `v*` tag is pushed:

```bash
npm version patch       # bumps package.json and creates a vX.Y.Z tag
git push --follow-tags
```

## Architecture

A single Electron app. The main process is the sole broker — it owns the UI window,
node-pty PTY management, and session persistence; the renderer reaches privileged
work only through the `window.api` contextBridge, never node-pty or the filesystem
directly. Sessions are persisted in-process as a small JSON file in the per-user app
data dir (no database, no second runtime); context-window occupancy is read live from
each session's Claude Code transcript.

Built with Electron, TypeScript (strict), xterm.js, node-pty, and Tailwind CSS v4.
See [`CLAUDE.md`](CLAUDE.md) for the full design and file map.

## License

MIT
