import type { BookDelta, BookHealth, BookId, BookSnapshot, FeedState } from '../core/types.js';
import type { Phase } from '../core/latency.js';

/** What an adapter hands its output to. One ingestion per book, shared by every viewer. */
export interface AdapterSink {
  /** Returns how many quotes actually changed. */
  snapshot(s: BookSnapshot): number;
  delta(d: BookDelta): number;
  latency(phase: Phase, metric: string, ms: number): void;
  log(msg: string, extra?: Record<string, unknown>): void;
}

/** The seam for a third book: implement this and register it in server.ts. */
export interface BookAdapter {
  readonly book: BookId;
  start(sink: AdapterSink): void;
  stop(): void;
  health(): BookHealth;
  /** Force a fresh full read now (rate-limited by the adapter). */
  refresh(): Promise<void>;
  /** Extra diagnostics for /api/metrics. */
  stats(): Record<string, unknown>;
}

/** Shared bookkeeping for feed state, contact times and the stale rule. */
export class HealthTracker {
  state: FeedState = 'connecting';
  lastContactTs: number | null = null;
  lastChangeTs: number | null = null;
  lastError: string | null = null;
  detail: string | undefined;

  constructor(
    readonly book: BookId,
    public transport: 'push' | 'poll',
    private readonly staleAfterMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  contact(): void {
    this.lastContactTs = this.now();
  }
  changed(): void {
    this.lastChangeTs = this.now();
  }
  error(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
  }

  snapshot(): BookHealth {
    let state = this.state;
    const age = this.lastContactTs === null ? Infinity : this.now() - this.lastContactTs;
    if (state !== 'disabled' && state !== 'connecting' && age > this.staleAfterMs) state = 'stale';
    return {
      book: this.book,
      state,
      transport: this.transport,
      lastContactTs: this.lastContactTs,
      lastChangeTs: this.lastChangeTs,
      lastError: this.lastError,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}${body ? `: ${body.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
  }
}

export async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ body: unknown; res: Response; ms: number }> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${init.timeoutMs ?? 8000} ms`)), init.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response from ${new URL(url).host} (${text.slice(0, 60).replace(/\s+/g, ' ')}…)`);
    }
    return { body, res, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export function backoff(attempt: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10));
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
export const numOr = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
