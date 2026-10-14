import type { BookId } from './types.js';

export type Phase = 'pregame' | 'live';

/** Ring buffers of latency samples, per book and phase, with percentiles. */
export class LatencyTracker {
  private samples = new Map<string, number[]>();
  constructor(private readonly size = 500) {}

  record(book: BookId, phase: Phase, metric: string, ms: number): void {
    if (!Number.isFinite(ms)) return;
    const k = `${book}|${phase}|${metric}`;
    let arr = this.samples.get(k);
    if (!arr) this.samples.set(k, (arr = []));
    arr.push(ms);
    if (arr.length > this.size) arr.shift();
  }

  summary(): Record<string, { n: number; p50: number; p95: number; max: number }> {
    const out: Record<string, { n: number; p50: number; p95: number; max: number }> = {};
    for (const [k, arr] of this.samples) {
      if (!arr.length) continue;
      const s = [...arr].sort((a, b) => a - b);
      out[k] = { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s[s.length - 1]! };
    }
    return out;
  }
}

export function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[i]!);
}

/**
 * Clock skew between us and a book, estimated NTP-style and then tightened from traffic:
 * a message can't arrive before it was sent, so (receive - bookPublish) has a floor of
 * (-skew + one-way delay). We track the minimum over a window.
 */
export class SkewEstimator {
  private offsetMs = 0; // bookClock - ourClock
  private known = false;

  fromRoundTrip(sentAt: number, receivedAt: number, bookTs: number): void {
    if (!Number.isFinite(bookTs)) return;
    this.offsetMs = bookTs - (sentAt + (receivedAt - sentAt) / 2);
    this.known = true;
  }

  /** Called with every pushed message's publish timestamp. */
  observe(bookPublishTs: number, receivedAt: number): void {
    if (!Number.isFinite(bookPublishTs)) return;
    const wire = receivedAt - (bookPublishTs - this.offsetMs);
    if (wire < 0) this.offsetMs += wire; // impossible: our estimate is off; nudge it
    this.known = true;
  }

  /** Convert a book timestamp to our clock. */
  toLocal(bookTs: number): number {
    return bookTs - this.offsetMs;
  }

  get offset(): number {
    return Math.round(this.offsetMs);
  }
  get isKnown(): boolean {
    return this.known;
  }
}
