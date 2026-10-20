import WebSocket from 'ws';
import { BROWSER_UA, type Config } from '../../config.js';
import { SkewEstimator } from '../../core/latency.js';
import type { BookHealth, Quote } from '../../core/types.js';
import { quoteKey } from '../../core/types.js';
import { backoff, fetchJson, HealthTracker, isObj, str, type AdapterSink, type BookAdapter } from '../adapter.js';
import { DK_TD_PATH, DkBoard, parseDkProps, parseDkTime, type DkFrameData } from './normalize.js';

/**
 * DraftKings: the two channels their own web client uses.
 *   1. REST snapshot  GET sportsbook-nash.draftkings.com/api/sportscontent/{site}/v1/leagues/88808
 *      → full board; also carries `subscriptionPartials`, the exact socket queries their client sends.
 *   2. Push socket    wss://sportsbook-ws-{region}.draftkings.com/websocket?format=json
 *      → JSON-RPC subscribe, then deltas only, each stamped with DK's own createdTime.
 * The socket is the live path; REST bootstraps, re-checks every minute, and is the fallback
 * (polled every few seconds) whenever the socket is down.
 */
export class DraftKingsAdapter implements BookAdapter {
  readonly book = 'draftkings' as const;
  private readonly h: HealthTracker;
  private readonly board = new DkBoard();
  private readonly skew = new SkewEstimator();
  private sink!: AdapterSink;
  private ws: WebSocket | null = null;
  private stopped = false;
  private partials: Array<{ key: string; entity: string; query: string; includeMarkets?: string }> = [];
  private emittedByEvent = new Map<string, Set<string>>();
  private wsAttempt = 0;
  private snapAttempt = 0;
  private subscribedAt: number | null = null;
  private wsDownSince: number | null = Date.now();
  private lastResync = 0;
  private timers = new Set<NodeJS.Timeout>();
  private pollTimer: NodeJS.Timeout | null = null;
  private counters = { frames: 0, snapshots: 0, snapshotErrors: 0, unresolved: 0, resyncCorrections: 0, reconnects: 0 };
  private lastSnapshotMs: number | null = null;
  private snapshotInFlight: Promise<void> | null = null;
  private propQuotes = new Map<string, Quote>(); // player props, by quote key
  private gameKeyByEvent = new Map<string, string>();

  constructor(private readonly cfg: Config['dk'], staleAfterMs: number) {
    this.h = new HealthTracker('draftkings', 'push', staleAfterMs);
  }

  get snapshotUrl(): string {
    return this.cfg.restUrl ?? `https://sportsbook-nash.draftkings.com/api/sportscontent/${this.cfg.site}/v1/leagues/${this.cfg.leagueId}`;
  }

  start(sink: AdapterSink): void {
    this.sink = sink;
    this.stopped = false;
    void this.bootstrap();
    if (this.cfg.propsEnabled) this.later(() => void this.pollProps(), 2_000);
    // Integrity re-check + fallback scheduler: one loop decides between "check every minute" and "poll".
    this.pollTimer = setInterval(() => this.tick(), 1_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const t of this.timers) clearTimeout(t);
    this.ws?.terminate();
    this.ws = null;
  }

  health(): BookHealth {
    return this.h.snapshot();
  }

  stats(): Record<string, unknown> {
    return {
      ...this.counters,
      invalidEntities: this.board.invalid,
      socket: this.subscribedAt ? 'subscribed' : this.ws ? 'connecting' : 'down',
      clockOffsetMs: this.skew.offset,
      // Self-check: if the skew estimate were wrong, network samples would go negative.
      clockCheck: { samples: this.skew.samples, negativeCorrected: this.skew.negativeWire },
      lastSnapshotMs: this.lastSnapshotMs,
      snapshotUrl: this.snapshotUrl,
      wsUrl: this.cfg.wsUrl,
      entities: { events: this.board.events.size, markets: this.board.markets.size, selections: this.board.selections.size },
    };
  }

  async refresh(): Promise<void> {
    await this.fetchSnapshot('manual');
  }

  /* ---------------- snapshot ---------------- */

  private async bootstrap(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.fetchSnapshot('boot');
        this.connectSocket();
        return;
      } catch {
        const wait = backoff(this.snapAttempt++, 1_000, 30_000);
        this.h.state = 'degraded';
        await this.sleep(wait);
      }
    }
  }

  private fetchSnapshot(reason: string): Promise<void> {
    // Coalesce concurrent requests (tick + reconnect + manual refresh).
    this.snapshotInFlight ??= this.doFetchSnapshot(reason).finally(() => (this.snapshotInFlight = null));
    return this.snapshotInFlight;
  }

  private async doFetchSnapshot(reason: string): Promise<void> {
    this.lastResync = Date.now();
    try {
      const { body, ms } = await fetchJson(this.snapshotUrl, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate, br', // Node's fetch asks only for gzip/deflate by default
          'Accept-Language': 'en-US,en;q=0.9',
          Origin: 'https://sportsbook.draftkings.com',
          Referer: 'https://sportsbook.draftkings.com/',
        },
      });
      const receivedTs = Date.now();
      this.lastSnapshotMs = ms;
      this.counters.snapshots++;
      this.snapAttempt = 0;
      this.h.contact();
      this.board.load(body);
      this.readPartials(body);

      const { games, quotes } = this.board.normalize(undefined, { sourceTs: receivedTs, receivedTs });
      this.emittedByEvent.clear();
      const eventOf = new Map(games.map((g) => [g.gameKey, g.bookEventId]));
      this.gameKeyByEvent = new Map(games.map((g) => [g.bookEventId, g.gameKey]));
      for (const q of quotes) this.track(q.gameKey, quoteKey(q), eventOf.get(q.gameKey));
      // The store diffs; on a re-check while live, any change is something the socket didn't deliver.
      // Props come from their own section; carry them so a game-line re-check doesn't read as their removal.
      const changed = this.sink.snapshot({ book: 'draftkings', games, quotes: [...quotes, ...this.propQuotes.values()] });
      if (changed) this.h.changed();
      if (reason === 'resync' && this.subscribedAt) this.counters.resyncCorrections += changed;
      if (!this.subscribedAt) this.h.state = 'polling';
      this.h.lastError = this.subscribedAt ? null : this.h.lastError;
      this.sink.latency('pregame', 'snapshot_fetch', ms);
    } catch (err) {
      this.counters.snapshotErrors++;
      this.h.error(err);
      if (!this.subscribedAt) this.h.state = 'degraded';
      this.sink.log('draftkings snapshot failed', { reason, error: String(err) });
      throw err;
    }
  }

  /* ---------------- player props ---------------- */

  /** TD scorer props from DraftKings' TD Scorers section, polled like the REST fallback. */
  private async pollProps(): Promise<void> {
    if (this.stopped) return;
    try {
      const { body } = await fetchJson(this.snapshotUrl + DK_TD_PATH, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br', Origin: 'https://sportsbook.draftkings.com', Referer: 'https://sportsbook.draftkings.com/' },
        timeoutMs: 8_000,
      });
      const receivedTs = Date.now();
      const quotes = parseDkProps(body, (id) => this.gameKeyByEvent.get(id), { sourceTs: receivedTs, receivedTs });
      const next = new Map(quotes.map((q) => [quoteKey(q), q]));
      const removed = [...this.propQuotes.keys()].filter((k) => !next.has(k));
      this.propQuotes = next;
      if (this.sink.delta({ book: 'draftkings', quotes, removed })) this.h.changed();
    } catch (err) {
      this.sink.log('draftkings props failed', { error: String(err) });
    }
    this.later(() => void this.pollProps(), this.cfg.propsMs);
  }

  private readPartials(body: unknown): void {
    const sp = isObj(body) && isObj(body.subscriptionPartials) ? body.subscriptionPartials : {};
    const next: typeof this.partials = [];
    for (const [key, v] of Object.entries(sp)) {
      if (!isObj(v) || !str(v.entity) || !str(v.query)) continue;
      next.push({ key, entity: str(v.entity)!, query: str(v.query)!, ...(str(v.includeMarkets) ? { includeMarkets: str(v.includeMarkets)! } : {}) });
    }
    if (next.length) this.partials = next;
  }

  private track(gameKey: string, key: string, eventId: string | undefined): void {
    if (!eventId) return;
    let set = this.emittedByEvent.get(eventId);
    if (!set) this.emittedByEvent.set(eventId, (set = new Set()));
    set.add(key);
  }

  /** Runs every second: decides whether the REST re-check or fallback poll is due. */
  private tick(): void {
    if (this.stopped || this.snapshotInFlight || this.counters.snapshots === 0) return;
    const now = Date.now();
    const socketOk = this.subscribedAt !== null;
    const downFor = this.wsDownSince ? now - this.wsDownSince : 0;
    const interval = socketOk ? this.cfg.resyncMs : downFor > this.cfg.wsFallbackAfterMs ? this.cfg.pollMs : this.cfg.resyncMs;
    if (now - this.lastResync >= interval) {
      this.fetchSnapshot(socketOk ? 'resync' : 'poll').catch(() => undefined);
    }
  }

  /* ---------------- socket ---------------- */

  private connectSocket(): void {
    if (this.stopped || this.ws) return;
    const ws = new WebSocket(this.cfg.wsUrl, {
      headers: { 'User-Agent': BROWSER_UA, Origin: 'https://sportsbook.draftkings.com' },
      handshakeTimeout: 10_000,
    });
    this.ws = ws;
    let pingTimer: NodeJS.Timeout | null = null;
    let lastActivity = Date.now();
    let subscribeSentAt = 0;
    const pending = new Set<string>();

    ws.on('open', () => {
      lastActivity = Date.now();
      const partials = this.partials.length
        ? this.partials
        : [{ key: `league-${this.cfg.leagueId}`, entity: 'events', query: `$filter=leagueId eq '${this.cfg.leagueId}'` }];
      subscribeSentAt = Date.now();
      for (const p of partials) {
        pending.add(p.key);
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'subscribe',
            id: p.key,
            params: {
              entity: p.entity,
              queryParams: { query: p.query, ...(p.includeMarkets ? { includeMarkets: p.includeMarkets } : {}), initialData: false, projection: 'sportsbook', locale: 'en-US' },
              forwardedHeaders: {},
              clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': 'unknown' },
              jwt: '',
              siteName: this.cfg.site,
            },
          }),
        );
      }
      // Abandon a subscription that is never acknowledged.
      this.later(() => {
        if (this.ws === ws && !this.subscribedAt) {
          this.h.error('socket subscribe not acknowledged in 10 s');
          ws.terminate();
        }
      }, 10_000);
      pingTimer = setInterval(() => {
        if (Date.now() - lastActivity > 45_000) {
          this.sink.log('draftkings socket silent for 45 s; reconnecting');
          ws.terminate();
          return;
        }
        try {
          ws.ping();
        } catch {
          /* closing */
        }
      }, 15_000);
    });

    ws.on('pong', () => {
      lastActivity = Date.now();
      if (this.subscribedAt) this.h.contact();
    });

    ws.on('message', (raw) => {
      const receivedTs = Date.now();
      lastActivity = receivedTs;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.h.error('socket sent a non-JSON frame');
        return;
      }
      if (!isObj(msg)) return;
      const event = str(msg.event);
      if (msg.error) {
        this.h.error(`socket error: ${JSON.stringify(msg.error).slice(0, 160)}`);
        return;
      }
      if (event === 'subscribed') {
        if (!this.subscribedAt) this.skew.fromRoundTrip(subscribeSentAt, receivedTs, parseDkTime(msg.websocketPublishTimestamp));
        pending.delete(str(msg.id) ?? '');
        this.onSubscribed();
        return;
      }
      if (event === 'unsubscribed') {
        ws.terminate();
        return;
      }
      if (event === 'update') this.onUpdate(msg, receivedTs);
    });

    ws.on('error', (err) => this.h.error(`socket: ${err.message}`));
    ws.on('close', (code) => {
      if (pingTimer) clearInterval(pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.subscribedAt = null;
      this.wsDownSince ??= Date.now();
      this.h.state = 'polling';
      this.h.detail = `socket closed (${code}); REST fallback`;
      if (this.stopped) return;
      this.counters.reconnects++;
      // 4000 = DK's "bad query params" close: retrying fast is pointless.
      const wait = code === 4000 ? 30_000 : backoff(this.wsAttempt++, 500, 15_000);
      this.later(() => this.connectSocket(), wait);
    });
  }

  private onSubscribed(): void {
    const wasDown = this.subscribedAt === null;
    this.subscribedAt = Date.now();
    this.wsAttempt = 0;
    this.wsDownSince = null;
    this.h.state = 'live';
    this.h.transport = 'push';
    this.h.detail = undefined;
    this.h.lastError = null;
    this.h.contact();
    // Fill any gap from while we were disconnected.
    if (wasDown && this.counters.snapshots > 0 && Date.now() - this.lastResync > 2_000) this.fetchSnapshot('reconnect').catch(() => undefined);
  }

  private onUpdate(msg: Record<string, unknown>, receivedTs: number): void {
    this.counters.frames++;
    this.h.contact();
    const outer = isObj(msg.data) ? msg.data : {};
    const data = (isObj(outer.data) ? outer.data : {}) as DkFrameData;
    const meta = isObj(outer.metadata) ? outer.metadata : {};
    const created = parseDkTime(meta.createdTime);
    const published = parseDkTime(msg.websocketPublishTimestamp);
    this.skew.observe(published, receivedTs);
    const sourceTs = Number.isFinite(created) ? Math.min(receivedTs, this.skew.toLocal(created)) : receivedTs;

    const { touchedEvents, unresolved } = this.board.apply(data);
    if (unresolved) {
      this.counters.unresolved += unresolved;
      if (Date.now() - this.lastResync > 10_000) this.fetchSnapshot('unresolved').catch(() => undefined);
    }
    if (!touchedEvents.size) return;

    const { games, quotes, missingEvents } = this.board.normalize(touchedEvents, { sourceTs, receivedTs });
    // Anything we previously showed for a touched event that is no longer produced was removed.
    const removed: string[] = [];
    for (const g of games) {
      const before = this.emittedByEvent.get(g.bookEventId) ?? new Set<string>();
      const now = new Set(quotes.filter((q) => q.gameKey === g.gameKey).map((q) => quoteKey(q)));
      for (const k of before) if (!now.has(k)) removed.push(k);
      this.emittedByEvent.set(g.bookEventId, now);
    }
    for (const ev of missingEvents) {
      for (const k of this.emittedByEvent.get(ev) ?? []) removed.push(k);
      this.emittedByEvent.delete(ev);
    }
    if (this.sink.delta({ book: 'draftkings', games, quotes, removed })) this.h.changed();

    const phase = games.some((g) => g.live) ? 'live' : 'pregame';
    if (Number.isFinite(created)) this.sink.latency(phase, 'book_to_server', receivedTs - sourceTs);
    if (Number.isFinite(published)) this.sink.latency(phase, 'network', receivedTs - this.skew.toLocal(published));
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => this.later(r, ms));
  }
}
