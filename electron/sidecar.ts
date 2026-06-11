// IPC client to the .NET sidecar. Spawns the published sidecar executable as a
// child process and talks to it over a named pipe (Windows) / Unix domain
// socket (macOS) using newline-delimited JSON. Each request carries an `id` so
// responses can be correlated; the sidecar echoes it back.
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PersistedSession } from './ipc.js';

const PIPE_PATH =
  process.platform === 'win32' ? '\\\\.\\pipe\\portus' : '/tmp/portus.sock';

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
}

interface Envelope {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export class SidecarClient {
  private child: ChildProcess | null = null;
  private socket: Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';

  /** Resolve the published sidecar executable for the current platform. */
  private sidecarPath(appPath: string): string {
    const exe = process.platform === 'win32' ? 'Portus.Sidecar.exe' : 'Portus.Sidecar';
    return join(appPath, 'dist', 'sidecar', exe);
  }

  async start(appPath: string, dbPath: string): Promise<void> {
    const exePath = this.sidecarPath(appPath);
    if (!existsSync(exePath)) {
      throw new Error(
        `Sidecar not found at ${exePath}. Run \`npm run sidecar:build\` first.`,
      );
    }

    this.child = spawn(exePath, [dbPath, PIPE_PATH], { stdio: 'inherit' });
    this.child.on('exit', (code) => {
      console.error(`[sidecar] exited with code ${code}`);
      this.child = null;
    });

    await this.connectWithRetry();
  }

  private async connectWithRetry(attempts = 40, delayMs = 50): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.connectOnce();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error('Could not connect to sidecar pipe');
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(PIPE_PATH);
      sock.setEncoding('utf8');
      sock.once('connect', () => {
        this.socket = sock;
        sock.on('data', (chunk: string) => this.onData(chunk));
        sock.on('error', (err) => console.error('[sidecar] socket error', err));
        resolve();
      });
      sock.once('error', reject);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let env: Envelope;
      try {
        env = JSON.parse(line) as Envelope;
      } catch {
        console.error('[sidecar] bad frame', line);
        continue;
      }
      const p = this.pending.get(env.id);
      if (!p) continue;
      this.pending.delete(env.id);
      if (env.ok) p.resolve(env.data);
      else p.reject(new Error(env.error ?? 'sidecar error'));
    }
  }

  private request<T>(cmd: string, data: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('sidecar not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject });
      socket.write(`${JSON.stringify({ id, cmd, data })}\n`);
    });
  }

  saveSession(session: PersistedSession): Promise<PersistedSession> {
    return this.request('session.save', session);
  }

  listSessions(): Promise<PersistedSession[]> {
    return this.request('session.list', {});
  }

  getSession(id: string): Promise<PersistedSession | null> {
    return this.request('session.get', { id });
  }

  deleteSession(id: string): Promise<void> {
    return this.request('session.delete', { id });
  }

  addUsage(sessionId: string, tokensIn: number, tokensOut: number): Promise<PersistedSession> {
    return this.request('usage.add', { sessionId, tokensIn, tokensOut });
  }

  dispose(): void {
    this.socket?.destroy();
    this.child?.kill();
    this.socket = null;
    this.child = null;
  }
}
