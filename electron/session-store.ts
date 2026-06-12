// In-process session persistence. Replaces the old .NET sidecar: the session
// list is a small, single-writer dataset, so it lives as a JSON file in the
// per-user app data dir and is held in memory while the app runs. No second
// runtime, no native dependency, no cross-process pipe — see CLAUDE.md.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { PersistedSession } from './ipc.js';

/**
 * Cost model for token usage. Rates are USD per million tokens and are the
 * single source of truth for cost aggregation. Adjust as Claude pricing
 * changes; a future revision can load these from settings instead of constants.
 */
const INPUT_RATE_PER_MILLION = 3.0;
const OUTPUT_RATE_PER_MILLION = 15.0;

function costOf(tokensIn: number, tokensOut: number): number {
  return (
    (tokensIn / 1_000_000) * INPUT_RATE_PER_MILLION +
    (tokensOut / 1_000_000) * OUTPUT_RATE_PER_MILLION
  );
}

/**
 * JSON-backed session store. Loads the whole file into a Map on construction and
 * rewrites it (atomically, via temp-file + rename) on every mutation. Reads serve
 * from memory. The dataset is a handful of sessions, so this is plenty.
 */
export class SessionStore {
  private readonly sessions = new Map<string, PersistedSession>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedSession[];
      if (Array.isArray(parsed)) {
        for (const s of parsed) this.sessions.set(s.id, s);
      }
    } catch {
      // No file yet (first run) or unreadable/corrupt — start empty.
    }
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.sessions.values()], null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  /** Insert a new session or patch an existing one, then return the stored row. */
  save(incoming: PersistedSession): PersistedSession {
    const existing = this.sessions.get(incoming.id);
    if (!existing) {
      this.sessions.set(incoming.id, incoming);
    } else {
      existing.folder = incoming.folder;
      existing.claudeId = incoming.claudeId;
      existing.title = incoming.title;
      existing.lastActive = incoming.lastActive;
      // Token/cost totals are owned by addUsage(); don't clobber them on a plain
      // save unless the caller actually carried new totals.
      if (incoming.totalTokens > 0) existing.totalTokens = incoming.totalTokens;
      if (incoming.totalCost > 0) existing.totalCost = incoming.totalCost;
    }
    this.persist();
    return this.sessions.get(incoming.id)!;
  }

  list(): PersistedSession[] {
    return [...this.sessions.values()];
  }

  get(id: string): PersistedSession | null {
    return this.sessions.get(id) ?? null;
  }

  delete(id: string): void {
    if (this.sessions.delete(id)) this.persist();
  }

  /** Drop sessions last active before `cutoffIso`. Returns how many were removed.
   *  ISO-8601 timestamps compare correctly as plain strings. */
  pruneOlderThan(cutoffIso: string): number {
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (s.lastActive < cutoffIso) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if (removed) this.persist();
    return removed;
  }

  /** Apply a usage delta and return the updated session. */
  addUsage(id: string, tokensIn: number, tokensOut: number, lastActive: string): PersistedSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown session ${id}`);
    session.totalTokens += tokensIn + tokensOut;
    session.totalCost += costOf(tokensIn, tokensOut);
    session.lastActive = lastActive;
    this.persist();
    return session;
  }
}
