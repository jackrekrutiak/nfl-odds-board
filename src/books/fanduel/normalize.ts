import { toOdds } from '../../core/odds.js';
import { playerKey } from '../../core/players.js';
import { makeGameKey, resolveTeam, splitMatchup } from '../../core/teams.js';
import type { BookGame, MarketType, Quote, SideKey } from '../../core/types.js';
import { isObj, numOr, str } from '../adapter.js';

/**
 * FanDuel's coupon page (`content-managed-page`) is a full picture every time, keyed by id:
 *   attachments.events[id]  { eventId, name: "AWAY @ HOME", openDate, inPlay? }
 *   attachments.markets[id] { marketId, eventId, marketType, marketStatus, inPlay, runners[] }
 *   runner { selectionId, handicap, runnerName, result.type HOME|AWAY|OVER|UNDER, runnerStatus, winRunnerOdds }
 * It carries no timestamps. The price channel (getMarketPrices) returns the same runner shape
 * for the markets you ask for, uncached, and is overlaid on top of the page.
 */
const TYPE_MAP: Record<string, MarketType> = {
  MONEY_LINE: 'moneyline',
  'MATCH_HANDICAP_(2-WAY)': 'spread',
  'TOTAL_POINTS_(OVER/UNDER)': 'total',
};

/** Player props read from each game's event page (tab=td-scorer-props). Yes-only: one price per player, no line. */
export const PROP_TYPES: Record<string, MarketType> = {
  ANY_TIME_TOUCHDOWN_SCORER: 'td_anytime',
};
const LINELESS = new Set<MarketType>(['moneyline', 'td_anytime']);

/** Over/under player props: marketType PLAYER_X_<STAT>[_HIGH|_MEDIUM|_LOW], marketName "Caleb Williams - Passing Yds",
 *  two runners with result.type OVER/UNDER and the line in handicap. ALT_ markets are ladders: left out for now. */
const FD_STATS: Record<string, string> = {
  PASSING_YARDS: 'passing_yds',
  PASSING_TOUCHDOWNS: 'passing_tds',
  PASSING_COMPLETIONS: 'pass_completions',
  PASSING_ATTEMPTS: 'pass_attempts',
  INTERCEPTIONS: 'interceptions',
  RUSHING_YARDS: 'rushing_yds',
  RUSHING_ATTEMPTS: 'rush_attempts',
  RECEIVING_YARDS: 'receiving_yds',
  RECEPTIONS: 'receptions',
  'RUSHING_+_RECEIVING_YARDS': 'rush_rec_yds',
};
export function fdPropType(marketType: string): MarketType | null {
  const m = /^PLAYER_X_(?!ALT_)(.+?)(?:_(?:HIGH|MEDIUM|LOW))?$/.exec(marketType);
  const stat = m ? FD_STATS[m[1]!] : undefined;
  return stat ? `prop:${stat}` : null;
}

export interface FdRunner {
  selectionId: string;
  player?: string;
  side: SideKey;
  line: number | null;
  american: number;
  decimal: number;
  suspended: boolean;
  fromPrices?: boolean;
}

export interface FdMarket {
  marketId: string;
  eventId: string;
  type: MarketType;
  suspended: boolean;
  inPlay: boolean;
  runners: Map<string, FdRunner>; // by selectionId
}

export class FdBoard {
  games = new Map<string, BookGame>(); // by eventId
  markets = new Map<string, FdMarket>(); // by marketId
  propMarkets = new Map<string, FdMarket>(); // by marketId, from each game's event page
  invalid = 0;

  loadPage(page: unknown, keepPriceOverlay = false): void {
    const att = isObj(page) && isObj(page.attachments) ? page.attachments : {};
    const events = isObj(att.events) ? att.events : {};
    const markets = isObj(att.markets) ? att.markets : {};
    const games = new Map<string, BookGame>();
    const next = new Map<string, FdMarket>();

    for (const raw of Object.values(markets)) {
      if (!isObj(raw)) continue;
      const type = TYPE_MAP[str(raw.marketType) ?? ''];
      if (!type) continue; // futures, props, specials: not in scope, not an error
      const marketId = str(raw.marketId);
      const eventId = str(raw.eventId);
      if (!marketId || !eventId) {
        this.invalid++;
        continue;
      }
      if (!games.has(eventId)) {
        const g = toGame(events[eventId], eventId);
        if (!g) continue;
        games.set(eventId, g);
      }
      const m: FdMarket = { marketId, eventId, type, suspended: isSuspended(raw.marketStatus), inPlay: raw.inPlay === true, runners: new Map() };
      for (const r of Array.isArray(raw.runners) ? raw.runners : []) {
        const runner = toRunner(r, type);
        if (runner) m.runners.set(runner.selectionId, runner);
        else this.invalid++;
      }
      // One main market per type per game; keep the first.
      if (![...next.values()].some((x) => x.eventId === eventId && x.type === type)) next.set(marketId, m);
    }
    for (const m of next.values()) {
      const g = games.get(m.eventId);
      if (g && m.inPlay) g.live = true;
    }
    // While the price channel is healthy its numbers are fresher than the (CDN-cached) page's.
    if (keepPriceOverlay) for (const [id, m] of next) {
      const old = this.markets.get(id);
      if (!old) continue;
      for (const [sid, r] of m.runners) {
        const o = old.runners.get(sid);
        if (o?.fromPrices) m.runners.set(sid, o);
      }
    }
    this.games = games;
    this.markets = next;
  }

  /** Load one game's props tab. Replaces that game's prop markets; keeps fresher prices from the price channel. */
  loadProps(eventId: string, page: unknown): number {
    const att = isObj(page) && isObj(page.attachments) ? page.attachments : {};
    const markets = isObj(att.markets) ? att.markets : {};
    const next = new Map<string, FdMarket>();
    for (const raw of Object.values(markets)) {
      if (!isObj(raw) || str(raw.eventId) !== eventId) continue;
      const type = PROP_TYPES[str(raw.marketType) ?? ''] ?? fdPropType(str(raw.marketType) ?? '');
      const marketId = str(raw.marketId);
      if (!type || !marketId) continue;
      const player = type.startsWith('prop:') ? (str(raw.marketName) ?? '').split(' - ')[0]!.trim() : '';
      const m: FdMarket = { marketId, eventId, type, suspended: isSuspended(raw.marketStatus), inPlay: raw.inPlay === true, runners: new Map() };
      for (const r of Array.isArray(raw.runners) ? raw.runners : []) {
        const runner = type.startsWith('prop:') ? toOverUnderRunner(r, player) : toPropRunner(r);
        if (runner) m.runners.set(runner.selectionId, runner);
      }
      const old = this.propMarkets.get(marketId);
      if (old) for (const [sid, r] of m.runners) { const o = old.runners.get(sid); if (o?.fromPrices) m.runners.set(sid, o); }
      if (m.runners.size) next.set(marketId, m);
    }
    for (const [id, m] of this.propMarkets) if (m.eventId === eventId) this.propMarkets.delete(id);
    for (const [id, m] of next) this.propMarkets.set(id, m);
    return next.size;
  }

  /** Overlay the price channel's answer. Returns selection ids we don't know (→ structure refresh). */
  applyPrices(entries: unknown[]): { unknown: number; updated: number } {
    let unknown = 0;
    let updated = 0;
    for (const e of entries) {
      if (!isObj(e)) {
        this.invalid++;
        continue;
      }
      const id = str(e.marketId) ?? '';
      const m = this.markets.get(id) ?? this.propMarkets.get(id);
      if (!m) continue;
      const status = (str(e.marketStatus) ?? 'OPEN').toUpperCase();
      if (status === 'CLOSED') {
        this.markets.delete(m.marketId);
        this.propMarkets.delete(m.marketId);
        continue;
      }
      m.suspended = status === 'SUSPENDED';
      if (e.inplay === true || e.inPlay === true) {
        m.inPlay = true;
        const g = this.games.get(m.eventId);
        if (g) g.live = true;
      }
      for (const r of Array.isArray(e.runnerDetails) ? e.runnerDetails : []) {
        if (!isObj(r)) continue;
        const sid = str(r.selectionId);
        const known = sid ? m.runners.get(sid) : undefined;
        if (!known) {
          unknown++;
          continue;
        }
        const odds = oddsOf(r.winRunnerOdds);
        if (!odds) continue;
        const line = LINELESS.has(m.type) ? null : (numOr(r.handicap) ?? known.line);
        const next = { ...known, ...odds, line, suspended: isSuspended(r.runnerStatus), fromPrices: true };
        m.runners.set(known.selectionId, next);
        updated++;
      }
    }
    return { unknown, updated };
  }

  marketIds(which: 'all' | 'live' | 'pregame' = 'all', kind: 'all' | 'game' | 'prop' = 'all'): string[] {
    const out: string[] = [];
    const pool = kind === 'game' ? [...this.markets] : kind === 'prop' ? [...this.propMarkets] : [...this.markets, ...this.propMarkets];
    for (const [id, m] of pool) {
      const live = m.inPlay || this.games.get(m.eventId)?.live === true;
      if (which === 'all' || (which === 'live') === live) out.push(id);
    }
    return out;
  }

  normalize(ts: { sourceTs: number; receivedTs: number }): { games: BookGame[]; quotes: Quote[] } {
    const quotes: Quote[] = [];
    for (const m of [...this.markets.values(), ...this.propMarkets.values()]) {
      const g = this.games.get(m.eventId);
      if (!g) continue;
      for (const r of m.runners.values()) {
        quotes.push({
          ...(r.player ? { player: r.player } : {}),
          book: 'fanduel',
          gameKey: g.gameKey,
          market: m.type,
          side: r.side,
          line: r.line,
          american: r.american,
          decimal: r.decimal,
          suspended: m.suspended || r.suspended,
          sourceTs: ts.sourceTs,
          receivedTs: ts.receivedTs,
        });
      }
    }
    return { games: [...this.games.values()], quotes };
  }
}

function isSuspended(status: unknown): boolean {
  return (str(status) ?? '').toUpperCase() === 'SUSPENDED';
}

function oddsOf(w: unknown): { american: number; decimal: number } | null {
  if (!isObj(w)) return null;
  const a = isObj(w.americanDisplayOdds) ? w.americanDisplayOdds.americanOdds : undefined;
  const d = isObj(w.trueOdds) && isObj(w.trueOdds.decimalOdds) ? w.trueOdds.decimalOdds.decimalOdds : undefined;
  return toOdds(d, a);
}

function toGame(ev: unknown, eventId: string): BookGame | null {
  if (!isObj(ev)) return null;
  const pair = splitMatchup(str(ev.name));
  const away = pair ? resolveTeam(pair[0]) : null;
  const home = pair ? resolveTeam(pair[1]) : null;
  const startTime = Date.parse(str(ev.openDate) ?? '');
  if (!away || !home || !Number.isFinite(startTime)) return null;
  return { book: 'fanduel', gameKey: makeGameKey(away, home, startTime), bookEventId: eventId, away, home, startTime, live: ev.inPlay === true };
}

function toRunner(r: unknown, type: MarketType): FdRunner | null {
  if (!isObj(r)) return null;
  const selectionId = str(r.selectionId);
  const t = (isObj(r.result) ? (str(r.result.type) ?? '') : '').toLowerCase();
  const side = (['home', 'away', 'over', 'under'] as const).find((s) => s === t);
  const odds = oddsOf(r.winRunnerOdds);
  const status = (str(r.runnerStatus) ?? 'ACTIVE').toUpperCase();
  if (!selectionId || !side || !odds || status === 'REMOVED' || status === 'CLOSED') return null;
  const line = type === 'moneyline' ? null : (numOr(r.handicap) ?? null);
  if (type !== 'moneyline' && line === null) return null;
  return { selectionId, side, line, ...odds, suspended: status === 'SUSPENDED' };
}

function toPropRunner(r: unknown): FdRunner | null {
  if (!isObj(r)) return null;
  const selectionId = str(r.selectionId);
  const name = str(r.runnerName);
  const odds = oddsOf(r.winRunnerOdds);
  const status = (str(r.runnerStatus) ?? 'ACTIVE').toUpperCase();
  if (!selectionId || !name || !odds || status === 'REMOVED' || status === 'CLOSED') return null;
  if (/^no (touchdown|td)/i.test(name)) return null; // "No Touchdown Scorer" is not a player
  const key = playerKey(name);
  if (!key) return null;
  return { selectionId, player: name, side: `p:${key}`, line: null, ...odds, suspended: status === 'SUSPENDED' };
}

function toOverUnderRunner(r: unknown, player: string): FdRunner | null {
  if (!isObj(r) || !player) return null;
  const selectionId = str(r.selectionId);
  const t = (isObj(r.result) ? (str(r.result.type) ?? '') : '').toLowerCase();
  const odds = oddsOf(r.winRunnerOdds);
  const line = numOr(r.handicap);
  const status = (str(r.runnerStatus) ?? 'ACTIVE').toUpperCase();
  const key = playerKey(player);
  if (!selectionId || (t !== 'over' && t !== 'under') || !odds || line === undefined || line === null || !key || status === 'REMOVED' || status === 'CLOSED') return null;
  return { selectionId, player, side: `p:${key}:${t}`, line, ...odds, suspended: status === 'SUSPENDED' };
}
