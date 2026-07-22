// Owns the lifecycle of node-pty processes: one per terminal tab. Spawns the
// platform shell in a target folder, launches the agent CLI, forwards output to
// the renderer, and extracts the window title the agent publishes via OSC.
import * as os from 'node:os';
import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import type { SpawnRequest } from './ipc.js';

interface Listeners {
  onData: (ptyId: string, data: string) => void;
  onTitle: (ptyId: string, title: string) => void;
  onUsage: (ptyId: string, tokensIn: number, tokensOut: number) => void;
  onExit: (ptyId: string, exitCode: number) => void;
}

interface Session {
  id: string;
  proc: pty.IPty;
  folder: string;
  // Output coalescing: PTY output (incl. each keystroke's prompt redraw) often
  // arrives as a burst of small chunks. Buffer them and flush once per event-loop
  // turn so the renderer gets one IPC message + one render pass per burst instead
  // of per chunk — which keeps the renderer thread free to dispatch the user's
  // next keystroke.
  pending: string[];
  flushScheduled: boolean;
  /** Tail of a title sequence that was cut in half by a chunk boundary. */
  titleCarry: string;
  /** Last title reported to the renderer — repeats are dropped. */
  lastTitle: string | null;
}

function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env['SHELL'] ?? '/bin/bash';
}

// Best-effort parse of an end-of-turn usage summary. Claude Code's exact format
// is still an open question (see CLAUDE.md), so this stays tolerant: it looks
// for "<n> in" / "<n> out" style token counts and yields nothing otherwise.
const USAGE_RE = /(\d[\d,]*)\s*(?:tokens?\s*)?in\b.*?(\d[\d,]*)\s*(?:tokens?\s*)?out\b/i;

function parseUsage(chunk: string): { tokensIn: number; tokensOut: number } | null {
  const m = USAGE_RE.exec(chunk);
  if (!m) return null;
  const toNum = (s: string) => Number(s.replace(/,/g, ''));
  return { tokensIn: toNum(m[1]!), tokensOut: toNum(m[2]!) };
}

// --- Window title (OSC) ----------------------------------------------------
// Agent CLIs publish their current state through the terminal's window title:
// `ESC ] 0 ; <text> BEL` (or OSC 2, or terminated by ST = `ESC \`). Claude Code
// animates a small glyph in there while it's working, which is the liveliest
// signal a tab has. Parsing it here — off the raw PTY stream — means a tab's
// label tracks the agent regardless of whether its terminal is on screen.

/** OSC 0/2 window-title sequence, terminated by BEL or ST. */
const OSC_TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
/** A trailing, still-unterminated OSC 0/2 introducer worth carrying over. */
const OSC_TITLE_PARTIAL_RE = /^\x1b\][02]?;?[^\x07\x1b]*$/;
/** Cap on the carried-over fragment, so a stray `ESC ]` can't grow unbounded. */
const TITLE_CARRY_MAX = 1024;

/**
 * Pull the most recent window title out of a chunk, carrying an incomplete
 * sequence over to the next one. Only the last title in the chunk matters — the
 * intermediate frames of an animation collapse into the one the terminal would
 * end up showing.
 */
function takeTitle(session: Session, data: string): string | null {
  const buf = session.titleCarry ? session.titleCarry + data : data;
  let title: string | null = null;
  let consumed = 0;
  OSC_TITLE_RE.lastIndex = 0;
  for (let m = OSC_TITLE_RE.exec(buf); m; m = OSC_TITLE_RE.exec(buf)) {
    title = m[1]!;
    consumed = OSC_TITLE_RE.lastIndex;
  }
  const rest = buf.slice(consumed);
  const start = rest.lastIndexOf('\x1b]');
  const tail = start >= 0 ? rest.slice(start) : '';
  session.titleCarry =
    tail.length > 0 && tail.length <= TITLE_CARRY_MAX && OSC_TITLE_PARTIAL_RE.test(tail)
      ? tail
      : '';
  return title;
}

export class PtyManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly listeners: Listeners) {}

  spawn(req: SpawnRequest): string {
    const id = randomUUID();
    const proc = pty.spawn(defaultShell(), [], {
      name: 'xterm-256color',
      cols: req.cols,
      rows: req.rows,
      cwd: req.folder,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const session: Session = {
      id,
      proc,
      folder: req.folder,
      pending: [],
      flushScheduled: false,
      titleCarry: '',
      lastTitle: null,
    };
    this.sessions.set(id, session);

    proc.onData((data) => this.handleData(session, data));
    proc.onExit(({ exitCode }) => {
      this.flush(session); // drain any buffered output before the tab goes away
      this.sessions.delete(id);
      this.listeners.onExit(id, exitCode);
    });

    // Launch the agent CLI. Routing it through the shell means the tab is still
    // a usable terminal if the CLI is missing or the user exits it.
    const startup = req.startupCommand ?? 'claude';
    if (startup.trim().length > 0) {
      proc.write(`${startup}${os.EOL}`);
    }

    return id;
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (s && cols > 0 && rows > 0) s.proc.resize(cols, rows);
  }

  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.proc.kill();
    this.sessions.delete(id);
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  private handleData(session: Session, data: string): void {
    session.pending.push(data);
    if (session.flushScheduled) return;
    session.flushScheduled = true;
    // setImmediate fires after the current I/O batch, so every chunk node-pty
    // delivered in this loop turn coalesces into one flush — near-zero added
    // latency, but the renderer sees one event per burst instead of many.
    setImmediate(() => this.flush(session));
  }

  private flush(session: Session): void {
    session.flushScheduled = false;
    if (session.pending.length === 0) return;
    const data = session.pending.length === 1 ? session.pending[0]! : session.pending.join('');
    session.pending.length = 0;

    this.listeners.onData(session.id, data);

    const usage = parseUsage(data);
    if (usage) this.listeners.onUsage(session.id, usage.tokensIn, usage.tokensOut);

    const title = takeTitle(session, data);
    if (title !== null && title !== session.lastTitle) {
      session.lastTitle = title;
      this.listeners.onTitle(session.id, title);
    }
  }
}
