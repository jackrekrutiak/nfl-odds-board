import type { ServerResponse } from 'node:http';
import type { ChangeSet, OddsStore } from '../core/store.js';
import { pickBest } from '../core/best.js';
import type { BookHealth, MarketType, Quote, SideKey } from '../core/types.js';
import { BOOKS, quoteKey } from '../core/types.js';
import { loadMoves, saveMove, type Move } from './moves-db.js';

/**
 * Fan-out to browsers over Server-Sent Events.
 *
 * - Each store change becomes one SSE frame, serialized ONCE and written to every client.
 * - No batching window: a DraftKings frame is ~one line move, and adding even 50 ms of
 *   batching would add 50 ms to every move for no real bandwidth win. The store already
 *   coalesces naturally (one upstream message → one ChangeSet → one frame).
 * - Every frame gets a sequence id; a reconnecting browser sends Last-Event-ID and gets the
 *   frames it missed from a ring buffer, or a fresh snapshot if it's too far behind.
 */
interface Client {
  res: ServerResponse;
  id: number;
}

const MOVES_KEPT = 40;

export class SseHub {
  private clients = new Set<Client>();
  private seq = 0;
  private ring: Array<{ seq: number; frame: string }> = [];
  private nextClientId = 1;
  private heartbeat: NodeJS.Timeout;
  private lastUnhealthy = '';
  /** Recent real price moves, newest first, so a refreshed page keeps its line-movement feed. */
  private moves: Move[] = [];
  sentFrames = 0;
  sentBytes = 0;

  constructor(
    private readonly store: OddsStore,
    private readonly health: () => BookHealth[],
    private readonly metrics: () => unknown,
    heartbeatMs: number,
    private readonly ringSize = 1_000,
  ) {
    store.on('change', (set) => {
      for (const c of set.changes) {
        if (c.quote && c.prev && (c.prev.american !== c.quote.american || c.prev.line !== c.quote.line)) {
          const m: Move = { at: Date.now(), q: c.quote, prev: c.prev };
          this.moves.unshift(m);
          saveMove(m);
        }
      }
      if (this.moves.length > MOVES_KEPT) this.moves.length = MOVES_KEPT;
      this.broadcast('delta', { ...toWire(set), best: this.bestFor(set) });
    });
    // On startup, bring back the moves saved before the last restart or deploy.
    loadMoves(MOVES_KEPT)
      .then((saved) => { this.moves = [...this.moves, ...saved].slice(0, MOVES_KEPT); })
      .catch((e) => console.error('loading saved moves failed', String(e)));
    this.heartbeat = setInterval(() => {
      const health = this.health();
      // A stale or broken book must not keep "winning" best price: when the set of healthy
      // books changes, recompute every slot and push the new winners.
      const unhealthy = health.filter((h) => !isHealthy(h)).map((h) => h.book).join(',');
      if (unhealthy !== this.lastUnhealthy) {
        this.lastUnhealthy = unhealthy;
        this.broadcast('delta', { book: null, emitTs: Date.now(), games: [], removedGames: [], changes: [], best: this.bestForSlots(this.allSlots()) });
      }
      this.broadcast('status', { serverTs: Date.now(), health, metrics: this.metrics() }, false);
    }, heartbeatMs);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  connect(res: ServerResponse, lastEventId: string | undefined): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx, Render, Fly)
    });
    res.socket?.setNoDelay(true);
    res.write('retry: 1000\n\n');
    const client: Client = { res, id: this.nextClientId++ };
    this.clients.add(client);
    res.on('close', () => this.clients.delete(client));

    const last = lastEventId !== undefined ? Number(lastEventId) : NaN;
    const oldest = this.ring[0]?.seq;
    if (Number.isFinite(last) && oldest !== undefined && last >= oldest - 1 && last <= this.seq) {
      for (const r of this.ring) if (r.seq > last) res.write(r.frame);
    } else {
      res.write(frame('snapshot', this.seq, this.snapshotPayload()));
    }
  }

  snapshotPayload(): unknown {
    return { serverTs: Date.now(), games: this.store.allGames(), quotes: this.store.allQuotes(), best: this.bestForSlots(this.allSlots()), health: this.health(), moves: this.moves };
  }

  private allSlots(): Set<string> {
    return new Set(this.store.allQuotes().map((q) => slotKey(q.gameKey, q.market, q.side)));
  }

  /** Best price is computed once here, not in every browser. Map: slot → winning quote key (or null). */
  private bestFor(set: ChangeSet): Record<string, string | null> {
    const slots = new Set<string>();
    for (const c of set.changes) {
      const [g, m, s] = c.key.split('|');
      slots.add(slotKey(g!, m as MarketType, s as SideKey));
    }
    return this.bestForSlots(slots);
  }

  private bestForSlots(slots: Set<string>): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    const health = this.health();
    const healthy = new Set(BOOKS.filter((b) => { const h = health.find((x) => x.book === b); return h && isHealthy(h); }));
    for (const slot of slots) {
      const [g, m, s] = slot.split('|') as [string, MarketType, SideKey];
      const qs = BOOKS.map((book) => this.store.quote(quoteKey({ book, gameKey: g, market: m, side: s }))).filter((q): q is Quote => !!q);
      // Prefer healthy books; fall back to whatever we have so a slot isn't blank.
      const fresh = qs.filter((q) => healthy.has(q.book));
      const best = pickBest(fresh.length ? fresh : qs);
      out[slot] = best ? quoteKey(best) : null;
    }
    return out;
  }

  private broadcast(event: string, data: unknown, buffered = true): void {
    const seq = buffered ? ++this.seq : this.seq;
    const f = frame(event, buffered ? seq : null, data);
    if (buffered) {
      this.ring.push({ seq, frame: f });
      if (this.ring.length > this.ringSize) this.ring.shift();
    }
    for (const c of this.clients) {
      // Drop clients whose socket can't keep up instead of buffering unboundedly.
      if (c.res.writableLength > 4 * 1024 * 1024) {
        c.res.destroy();
        this.clients.delete(c);
        continue;
      }
      c.res.write(f);
    }
    this.sentFrames++;
    this.sentBytes += f.length * this.clients.size;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }
}

function isHealthy(h: BookHealth): boolean {
  return h.state === 'live' || h.state === 'polling';
}

function slotKey(g: string, m: MarketType, s: SideKey): string {
  return `${g}|${m}|${s}`;
}

function frame(event: string, id: number | null, data: unknown): string {
  return `event: ${event}\n${id !== null ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}

/** Compact wire form of a change set; emitTs lets the browser measure server → screen. */
function toWire(set: ChangeSet) {
  return {
    book: set.book,
    emitTs: Date.now(),
    games: set.games,
    removedGames: set.removedGames,
    changes: set.changes.map((c) => ({ key: c.key, q: c.quote, prev: c.prev })),
  };
}
