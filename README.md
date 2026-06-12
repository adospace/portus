# portus — Agentic Terminal

> Mission control for multiple AI agent CLI sessions. Run every agent in one
> focused, three-pane window and watch them all at a glance.

<!-- ============================================================= -->
<!-- SCREENSHOTS — replace the placeholders below with real images -->
<!-- ============================================================= -->

<p align="center">
  <img src="docs/screenshot-main.png" alt="portus main window" width="800">
  <br>
  <em>Screenshot placeholder — drop images in <code>docs/</code> and update these paths.</em>
</p>

---

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
- **At-a-glance status.** Every tab shows whether its agent is *busy* (●, pulsing),
  *idle* (◌), or *done* (✓), plus a live elapsed timer while it's working — so you
  know which sessions need attention without clicking into them.
- **Start sessions where the work is.** The left pane is a lazy folder tree rooted
  at a drive/volume you pick; right-click any directory to launch an agent there.
- **Persistence + cost tracking.** Sessions survive app restarts, and token usage is
  accumulated into a running USD cost per session, shown in the status bar and the
  session-history pane.
- **Flexible layouts.** Split the center into 1, 4 (2×2), or 6 (3×2) panes, each its
  own tab group, and drag the gutters to resize.

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

Requires **Node.js 20+**, **npm**, and the **.NET 10 SDK**.

```bash
npm install             # node-pty ships N-API prebuilds — no native rebuild needed
npm run sidecar:build   # publish the .NET sidecar → dist/sidecar/ (once, or after C# changes)
npm start               # build + launch Electron
```

Use `npm run sidecar:build:mac` (osx-arm64) instead when building on macOS.

### Package distributables

```bash
npm run dist:win        # → release/portus-Setup-<version>.exe   (NSIS installer)
npm run dist:mac        # → release/portus-<version>-arm64.dmg + .zip
```

Each `dist:*` script builds the renderer/main bundles and the matching platform
sidecar before running electron-builder. Output lands in `release/`.

## Releasing

CI (`.github/workflows/release.yml`) builds Windows + macOS and publishes the
installers to GitHub Releases whenever a `v*` tag is pushed:

```bash
npm version patch       # bumps package.json and creates a vX.Y.Z tag
git push --follow-tags
```

## Architecture

Two processes:

- **Electron shell** — UI, xterm.js terminal emulation, and node-pty PTY management.
  The main process is the sole broker; the renderer reaches privileged work only
  through the `window.api` contextBridge.
- **.NET sidecar** — session persistence, usage tracking, and cost aggregation
  (SQLite via EF Core). Auto-started by Electron and spoken to over a named pipe
  (Windows) / Unix domain socket (macOS) with newline-delimited JSON.

Built with Electron, TypeScript (strict), xterm.js, node-pty, Tailwind CSS v4, and a
.NET 10 sidecar. See [`CLAUDE.md`](CLAUDE.md) for the full design and file map.

## License

MIT
