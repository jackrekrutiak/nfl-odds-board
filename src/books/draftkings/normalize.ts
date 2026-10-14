import { toOdds } from '../../core/odds.js';
import { makeGameKey, resolveTeam, splitMatchup } from '../../core/teams.js';
import type { BookGame, MarketType, Quote, SideKey, Team } from '../../core/types.js';
import { isObj, numOr, str } from '../adapter.js';

/**
 * DraftKings models the board relationally: flat lists of events, markets and selections that
 * point at each other by id. The REST snapshot gives all of them; the socket sends
 * {add, change, remove} × {events, markets, selections}, and `change` objects are partial.
 * DkBoard keeps the raw entities and turns any touched event into clean quotes.
 */
export type Raw = Record<string, unknown>;

export interface DkFrameData {
  add?: { events?: unknown[]; markets?: unknown[]; selections?: unknown[] };
  change?: { events?: unknown[]; markets?: unknown[]; selections?: unknown[] };
  remove?: { events?: unknown[]; markets?: unknown[]; selections?: unknown[] };
}

export interface ApplyResult {
  touchedEvents: Set<string>;
  unresolved: number; // changes that referenced something we don't know (→ resync)
}

export class DkBoard {
  events = new Map<string, Raw>();
  markets = new Map<string, Raw>();
  selections = new Map<string, Raw>();
  invalid = 0;

  load(snapshot: unknown): void {
    this.events.clear();
    this.markets.clear();
    this.selections.clear();
    const s = isObj(snapshot) ? snapshot : {};
    for (const e of list(s.events)) this.put(this.events, e);
    for (const m of list(s.markets)) this.put(this.markets, m);
    for (const x of list(s.selections)) this.put(this.selections, x);
  }

  apply(data: DkFrameData): ApplyResult {
    const touched = new Set<string>();
    let unresolved = 0;
    const touchMarket = (marketId: string | undefined) => {
      const m = marketId ? this.markets.get(marketId) : undefined;
      const ev = m && str(m.eventId);
      if (ev) touched.add(ev);
      return !!ev;
    };

    // Removals first: a line move often arrives as remove(old) + add(new).
    for (const ref of list(data.remove?.selections)) {
      const id = idOf(ref);
      const sel = id ? this.selections.get(id) : undefined;
      if (sel) touchMarket(str(sel.marketId));
      if (id) this.selections.delete(id);
    }
    for (const ref of list(data.remove?.markets)) {
      const id = idOf(ref);
      if (id) {
        touchMarket(id);
        this.markets.delete(id);
      }
    }
    for (const ref of list(data.remove?.events)) {
      const id = idOf(ref);
      if (id) {
        touched.add(id);
        this.events.delete(id);
      }
    }

    for (const kind of ['add', 'change'] as const) {
      const block = data[kind];
      for (const e of list(block?.events)) {
        const id = this.merge(this.events, e);
        if (id) touched.add(id);
      }
      for (const m of list(block?.markets)) {
        const id = this.merge(this.markets, m);
        if (!id) continue;
        if (!touchMarket(id)) unresolved++;
      }
      for (const x of list(block?.selections)) {
        if (!isObj(x)) {
          this.invalid++;
          continue;
        }
        // A line move gets a NEW selection id with `replacedSelectionId` → carry the old fields over.
        const replaced = str(x.replacedSelectionId);
        if (replaced && this.selections.has(replaced)) {
          const old = this.selections.get(replaced)!;
          this.selections.delete(replaced);
          touchMarket(str(old.marketId));
          const id = str(x.id);
          if (id) this.selections.set(id, { ...old, ...x, id });
        }
        const id = this.merge(this.selections, x);
        if (!id) continue;
        if (!touchMarket(str(this.selections.get(id)!.marketId))) unresolved++;
      }
    }
    return { touchedEvents: touched, unresolved };
  }

  private put(map: Map<string, Raw>, v: unknown): string | undefined {
    if (!isObj(v) || str(v.id) === undefined) {
      this.invalid++;
      return undefined;
    }
    const id = str(v.id)!;
    map.set(id, v);
    return id;
  }

  /** Merge a (possibly partial) entity onto what we have. */
  private merge(map: Map<string, Raw>, v: unknown): string | undefined {
    if (!isObj(v) || str(v.id) === undefined) {
      this.invalid++;
      return undefined;
    }
    const id = str(v.id)!;
    const old = map.get(id);
    map.set(id, old ? { ...old, ...v } : v);
    return id;
  }

  /** Clean games + quotes for the given events (all events if omitted). */
  normalize(eventIds: Iterable<string> | undefined, ts: { sourceTs: number; receivedTs: number }): { games: BookGame[]; quotes: Quote[]; missingEvents: string[] } {
    const ids = eventIds ? [...eventIds] : [...this.events.keys()];
    const marketsByEvent = new Map<string, Raw[]>();
    for (const m of this.markets.values()) {
      const ev = str(m.eventId);
      if (!ev) continue;
      (marketsByEvent.get(ev) ?? marketsByEvent.set(ev, []).get(ev)!).push(m);
    }
    const selsByMarket = new Map<string, Raw[]>();
    for (const s of this.selections.values()) {
      const mk = str(s.marketId);
      if (!mk) continue;
      (selsByMarket.get(mk) ?? selsByMarket.set(mk, []).get(mk)!).push(s);
    }

    const games: BookGame[] = [];
    const quotes: Quote[] = [];
    const missingEvents: string[] = [];
    for (const id of ids) {
      const ev = this.events.get(id);
      const game = ev && toGame(ev);
      if (!game) {
        missingEvents.push(id);
        continue;
      }
      games.push(game);
      const picked = pickMainMarkets(marketsByEvent.get(id) ?? []);
      for (const [type, m] of picked) {
        for (const s of selsByMarket.get(str(m.id)!) ?? []) {
          const q = toQuote(game, type, m, s, ts);
          if (q) quotes.push(q);
          else this.invalid++;
        }
      }
    }
    return { games, quotes, missingEvents };
  }
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function idOf(ref: unknown): string | undefined {
  return isObj(ref) ? str(ref.id) : str(ref);
}

export function parseDkTime(s: unknown): number {
  if (typeof s !== 'string') return NaN;
  // DK sends 7 fractional digits ("2026-10-18T17:00:00.0000000Z"); trim to milliseconds.
  return Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
}

function toGame(ev: Raw): BookGame | null {
  let away: Team | null = null;
  let home: Team | null = null;
  for (const p of list(ev.participants)) {
    if (!isObj(p)) continue;
    const role = str(p.venueRole)?.toLowerCase();
    const t = resolveTeam(str(p.name));
    if (role === 'home') home = t;
    else if (role === 'away') away = t;
  }
  if (!away || !home) {
    const pair = splitMatchup(str(ev.name));
    if (pair) {
      away ??= resolveTeam(pair[0]);
      home ??= resolveTeam(pair[1]);
    }
  }
  const startTime = parseDkTime(ev.startEventDate);
  if (!away || !home || !Number.isFinite(startTime)) return null;
  const status = (str(ev.status) ?? '').toUpperCase();
  const live = status === 'STARTED' || status === 'LIVE' || status === 'IN_PROGRESS';
  const game: BookGame = { book: 'draftkings', gameKey: makeGameKey(away, home, startTime), bookEventId: str(ev.id)!, away, home, startTime, live };
  const sc = isObj(ev.eventScorecard) && isObj(ev.eventScorecard.mainScorecard) ? ev.eventScorecard.mainScorecard : null;
  if (live && sc) {
    const a = numOr(sc.firstTeamScore);
    const h = numOr(sc.secondTeamScore);
    const period = isObj(ev.liveGameState) ? str(ev.liveGameState.period) : undefined;
    if (a !== undefined && h !== undefined) game.score = { away: a, home: h, ...(period ? { period } : {}) };
  }
  return game;
}

export function marketTypeOf(m: Raw): MarketType | null {
  const name = `${isObj(m.marketType) ? (str(m.marketType.name) ?? '') : ''} ${str(m.name) ?? ''}`.toLowerCase();
  if (/alternate|alt\b|team total|1st|2nd|quarter|half|player|race|odd\/even|3-way/.test(name)) return null;
  if (/moneyline|money line/.test(name)) return 'moneyline';
  if (/spread|handicap|point spread/.test(name)) return 'spread';
  if (/\btotal\b/.test(name)) return 'total';
  return null;
}

function pickMainMarkets(markets: Raw[]): Map<MarketType, Raw> {
  const out = new Map<MarketType, Raw>();
  for (const m of markets) {
    const t = marketTypeOf(m);
    if (!t) continue;
    const cur = out.get(t);
    if (!cur || (m.main === true && cur.main !== true)) out.set(t, m);
  }
  return out;
}

function toQuote(game: BookGame, market: MarketType, m: Raw, s: Raw, ts: { sourceTs: number; receivedTs: number }): Quote | null {
  const side = sideOf(game, market, s);
  const odds = toOdds(s.trueOdds, isObj(s.displayOdds) ? s.displayOdds.american : undefined);
  if (!side || !odds) return null;
  const points = numOr(s.points);
  const line = market === 'moneyline' ? null : (points ?? null);
  if (market !== 'moneyline' && line === null) return null;
  return {
    book: 'draftkings',
    gameKey: game.gameKey,
    market,
    side,
    line,
    american: odds.american,
    decimal: odds.decimal,
    suspended: m.isSuspended === true || s.isSuspended === true,
    sourceTs: ts.sourceTs,
    receivedTs: ts.receivedTs,
  };
}

function sideOf(game: BookGame, market: MarketType, s: Raw): SideKey | null {
  const outcome = (str(s.outcomeType) ?? '').toLowerCase();
  if (market === 'total') {
    if (outcome === 'over' || /^over/i.test(str(s.label) ?? '')) return 'over';
    if (outcome === 'under' || /^under/i.test(str(s.label) ?? '')) return 'under';
    return null;
  }
  if (outcome === 'home' || outcome === 'away') return outcome;
  for (const p of list(s.participants)) {
    const role = isObj(p) ? str(p.venueRole)?.toLowerCase() : undefined;
    if (role === 'home' || role === 'away') return role;
  }
  const t = resolveTeam(str(s.label));
  if (t?.id === game.home.id) return 'home';
  if (t?.id === game.away.id) return 'away';
  return null;
}
