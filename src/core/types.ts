/** The book-agnostic model. Nothing in here knows how DraftKings or FanDuel shape their data. */

export type BookId = 'draftkings' | 'fanduel';
export const BOOKS: BookId[] = ['draftkings', 'fanduel'];

export type MarketType = 'moneyline' | 'spread' | 'total' | 'td_anytime';
/** Game lines use away/home/over/under; player props use `p:<player key>` (see core/players.ts). */
export type SideKey = 'away' | 'home' | 'over' | 'under' | `p:${string}`;

export interface Team {
  id: string; // canonical abbreviation, e.g. "DET"
  name: string; // "Detroit Lions"
  short: string; // "Lions"
}

/** One price at one book: game + market + side + line + odds. */
export interface Quote {
  book: BookId;
  gameKey: string;
  market: MarketType;
  side: SideKey;
  line: number | null; // spread (signed for this side) or total; null for moneyline
  american: number;
  decimal: number;
  suspended: boolean;
  /** Player props only: the player's display name. */
  player?: string;
  /** When the book says the price changed (DK createdTime) or, if the book gives no clock, when we read it. */
  sourceTs: number;
  /** When our server had it. */
  receivedTs: number;
}

/** A game as one book lists it. Matched across books by `gameKey`. */
export interface BookGame {
  book: BookId;
  gameKey: string;
  bookEventId: string;
  away: Team;
  home: Team;
  startTime: number;
  live: boolean;
  score?: { away: number; home: number; period?: string };
}

/** A book's full read of the board. `quotes` covers every game in `games`. */
export interface BookSnapshot {
  book: BookId;
  games: BookGame[];
  quotes: Quote[];
}

/** An incremental change from a book: replace these games' quotes (or only the listed quotes). */
export interface BookDelta {
  book: BookId;
  games?: BookGame[];
  quotes: Quote[];
  /** Quote keys (see quoteKey) the book removed. */
  removed?: string[];
}

export type FeedState = 'connecting' | 'live' | 'polling' | 'degraded' | 'stale' | 'disabled';

export interface BookHealth {
  book: BookId;
  state: FeedState;
  transport: 'push' | 'poll';
  lastContactTs: number | null; // any successful exchange with the book
  lastChangeTs: number | null; // last time a price actually moved
  lastError: string | null;
  detail?: string;
}

export function quoteKey(q: Pick<Quote, 'book' | 'gameKey' | 'market' | 'side'>): string {
  return `${q.gameKey}|${q.market}|${q.side}|${q.book}`;
}
