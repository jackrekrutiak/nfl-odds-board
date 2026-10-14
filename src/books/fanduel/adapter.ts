import { BROWSER_UA, type Config } from '../../config.js';
import type { BookHealth } from '../../core/types.js';
import { backoff, fetchJson, HealthTracker, HttpError, type AdapterSink, type BookAdapter } from '../adapter.js';
import { FdBoard } from './normalize.js';

/**
 * FanDuel has no public push feed for sportsbook prices, so this is two polled channels:
 *   1. Structure: GET sbapi.{state}.sportsbook.fanduel.{tld}/api/content-managed-page?customPageId=nfl
 *      Which games/markets exist. Sits behind CloudFront (max-age=30), so it can be up to 30 s old
 *      whatever you do; read with If-None-Match so an unchanged page is a tiny 304.
 *   2. Prices: POST smp.{state}.sportsbook.fanduel.{tld}/api/sports/fixedodds/readonly/v1/getMarketPrices
 *      The uncached endpoint FanDuel's own betslip polls. ~1 KB per market, only the ids you ask for.
 *      This is what makes FanDuel's number fresh: its age is bounded by our poll interval + one RTT.
 * Both feed the same store, which diffs, so the browser still only sees changes.
 */
const BATCH = 70; // larger batches are silently truncated by FanDuel

export class FanDuelAdapter implements BookAdapter {
  readonly book = 'fanduel' as const;
  private readonly h: HealthTracker;
  private readonly board = new FdBoard();
  private sink!: AdapterSink;
  private stopped = false;
  private etag: string | null = null;
  private pageTimer: NodeJS.Timeout | null = null;
  private priceTimer: NodeJS.Timeout | null = null;
  private pageAttempt = 0;
  private priceAttempt = 0;
  private pricesHealthy = false;
  private lastPageAt = 0;
  private pagePromise: Promise<void> | null = null;
  private counters = { pageReads: 0, page304: 0, pageErrors: 0, pricePolls: 0, priceErrors: 0, priceUpdates: 0, unknownSelections: 0 };
  private lastRtt: { page: number | null; prices: number | null } = { page: null, prices: null };

  constructor(private readonly cfg: Config['fd'], staleAfterMs: number) {
    this.h = new HealthTracker('fanduel', 'poll', staleAfterMs);
  }

  start(sink: AdapterSink): void {
    this.sink = sink;
    this.stopped = false;
    this.schedulePage(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.pageTimer) clearTimeout(this.pageTimer);
    if (this.priceTimer) clearTimeout(this.priceTimer);
  }

  health(): BookHealth {
    const s = this.h.snapshot();
    const bound = this.pricesHealthy ? this.cfg.pricesMs + (this.lastRtt.prices ?? 0) : this.cfg.pageMs + 30_000;
    return { ...s, detail: `${this.pricesHealthy ? 'price channel' : 'page only (price channel down)'} · age ≤ ${(bound / 1000).toFixed(1)} s${s.detail ? ` · ${s.detail}` : ''}` };
  }

  stats(): Record<string, unknown> {
    return {
      ...this.counters,
      invalidEntities: this.board.invalid,
      pricesHealthy: this.pricesHealthy,
      markets: this.board.markets.size,
      games: this.board.games.size,
      lastRttMs: this.lastRtt,
      pageUrl: this.cfg.pageUrl,
      pricesUrl: this.cfg.pricesUrl,
      intervalsMs: { prices: this.cfg.pricesMs, page: this.cfg.pageMs },
    };
  }

  async refresh(): Promise<void> {
    this.etag = null;
    await this.readPage();
  }

  /* ---------------- structure ---------------- */

  private schedulePage(ms: number): void {
    if (this.stopped) return;
    if (this.pageTimer) clearTimeout(this.pageTimer);
    this.pageTimer = setTimeout(async () => {
      try {
        await this.readPage();
        this.pageAttempt = 0;
        this.schedulePage(this.cfg.pageMs);
        if (!this.priceTimer && this.cfg.pricesEnabled) this.schedulePrices(0);
      } catch (err) {
        const retryAfter = err instanceof HttpError && err.status === 429 ? 30_000 : 0;
        this.schedulePage(Math.max(retryAfter, backoff(this.pageAttempt++, 1_000, 30_000)));
      }
    }, ms);
  }

  private readPage(): Promise<void> {
    this.pagePromise ??= this.doReadPage().finally(() => (this.pagePromise = null));
    return this.pagePromise;
  }

  private async doReadPage(): Promise<void> {
    const url = new URL(this.cfg.pageUrl);
    url.searchParams.set('page', 'CUSTOM');
    url.searchParams.set('customPageId', this.cfg.pageId);
    url.searchParams.set('_ak', this.cfg.apiKey);
    url.searchParams.set('timezone', 'America/New_York');
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { ...this.headers(), ...(this.etag ? { 'If-None-Match': this.etag } : {}) },
        signal: AbortSignal.timeout(10_000),
      });
      this.lastRtt.page = Date.now() - started;
      this.lastPageAt = Date.now();
      if (res.status === 304) {
        this.counters.page304++;
        this.h.contact();
        return;
      }
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, url.toString(), text);
      const body: unknown = JSON.parse(text);
      this.etag = res.headers.get('etag');
      this.counters.pageReads++;
      this.board.loadPage(body, this.pricesHealthy);
      this.h.contact();
      if (this.board.markets.size === 0) this.h.detail = 'page returned no NFL game lines';
      else this.h.detail = undefined;
      this.publish();
      if (!this.pricesHealthy) this.h.state = this.board.markets.size ? 'polling' : 'degraded';
      this.sink.latency('pregame', 'page_rtt', this.lastRtt.page);
    } catch (err) {
      this.counters.pageErrors++;
      this.h.error(err);
      if (!this.pricesHealthy) this.h.state = 'degraded';
      this.sink.log('fanduel page failed', { error: String(err) });
      throw err;
    }
  }

  /* ---------------- prices ---------------- */

  private schedulePrices(ms: number): void {
    if (this.stopped) return;
    this.priceTimer = setTimeout(async () => {
      const started = Date.now();
      try {
        await this.readPrices();
        this.priceAttempt = 0;
        // Fixed cadence measured from the start of the last request, not its end.
        this.schedulePrices(Math.max(0, this.cfg.pricesMs - (Date.now() - started)));
      } catch {
        this.schedulePrices(backoff(this.priceAttempt++, this.cfg.pricesMs, 30_000));
      }
    }, ms);
  }

  private async readPrices(): Promise<void> {
    const ids = this.board.marketIds();
    if (!ids.length) return;
    const started = Date.now();
    try {
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
      const results = await Promise.all(
        batches.map((marketIds) =>
          fetchJson(this.cfg.pricesUrl, {
            method: 'POST',
            headers: { ...this.headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ marketIds }),
            timeoutMs: 6_000,
          }),
        ),
      );
      const receivedTs = Date.now();
      const entries = results.flatMap((r) => (Array.isArray(r.body) ? r.body : []));
      if (!entries.length) throw new Error('price channel returned no markets');
      const { unknown, updated } = this.board.applyPrices(entries);
      this.counters.pricePolls++;
      this.counters.priceUpdates += updated;
      this.lastRtt.prices = receivedTs - started;
      this.pricesHealthy = true;
      this.h.contact();
      this.h.state = 'live';
      this.h.lastError = null;
      const phase = [...this.board.games.values()].some((g) => g.live) ? 'live' : 'pregame';
      this.sink.latency(phase, 'poll_rtt', this.lastRtt.prices);
      // Upper bound on how old a FanDuel number can be when it reaches us.
      this.sink.latency(phase, 'book_to_server_bound', this.cfg.pricesMs + this.lastRtt.prices);
      this.publish(started);
      // A line move can re-key a selection that only the page knows about yet.
      if (unknown) {
        this.counters.unknownSelections += unknown;
        if (Date.now() - this.lastPageAt > 3_000) {
          this.etag = null;
          this.readPage().catch(() => undefined);
        }
      }
    } catch (err) {
      this.counters.priceErrors++;
      this.pricesHealthy = false;
      this.h.error(err);
      this.h.state = this.board.markets.size ? 'polling' : 'degraded';
      throw err;
    }
  }

  private publish(sourceTs = Date.now()): void {
    const receivedTs = Date.now();
    const { games, quotes } = this.board.normalize({ sourceTs, receivedTs });
    const n = this.sink.snapshot({ book: 'fanduel', games, quotes });
    if (n) this.h.changed();
  }

  private headers(): Record<string, string> {
    return {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: this.cfg.origin,
      Referer: `${this.cfg.origin}/`,
    };
  }
}
