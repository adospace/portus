// Owns the lifecycle of node-pty processes: one per terminal tab. Spawns the
// platform shell in a target folder, launches the agent CLI, and infers a
// coarse busy/idle status by watching the cadence of output.
import * as os from 'node:os';
import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import type { SessionStatus, SpawnRequest } from './ipc.js';

/** Quiet period (ms) after the last output byte before a session is "idle". */
const IDLE_AFTER_MS = 700;

interface Listeners {
  onData: (ptyId: string, data: string) => void;
  onStatus: (ptyId: string, status: SessionStatus) => void;
  onUsage: (ptyId: string, tokensIn: number, tokensOut: number) => void;
  onExit: (ptyId: string, exitCode: number) => void;
}

interface Session {
  id: string;
  proc: pty.IPty;
  folder: string;
  status: SessionStatus;
  idleTimer: NodeJS.Timeout | null;
  sawOutput: boolean;
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
      status: 'idle',
      idleTimer: null,
      sawOutput: false,
    };
    this.sessions.set(id, session);

    proc.onData((data) => this.handleData(session, data));
    proc.onExit(({ exitCode }) => {
      this.clearIdleTimer(session);
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
    this.clearIdleTimer(s);
    s.proc.kill();
    this.sessions.delete(id);
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  private handleData(session: Session, data: string): void {
    this.listeners.onData(session.id, data);
    session.sawOutput = true;

    const usage = parseUsage(data);
    if (usage) this.listeners.onUsage(session.id, usage.tokensIn, usage.tokensOut);

    this.setStatus(session, 'busy');
    this.clearIdleTimer(session);
    session.idleTimer = setTimeout(() => {
      // No output for a while → the agent has handed control back to the prompt.
      this.setStatus(session, 'idle');
    }, IDLE_AFTER_MS);
  }

  private setStatus(session: Session, status: SessionStatus): void {
    if (session.status === status) return;
    session.status = status;
    this.listeners.onStatus(session.id, status);
  }

  private clearIdleTimer(session: Session): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }
}
