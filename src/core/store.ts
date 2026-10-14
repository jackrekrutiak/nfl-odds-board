import { EventEmitter } from 'node:events';
import type { BookDelta, BookGame, BookId, BookSnapshot, Quote } from './types.js';
import { quoteKey } from './types.js';

export interface QuoteChange {
  key: string;
  quote: Quote | null; // null = removed
  prev: Pick<Quote, 'american' | 'line' | 'suspended'> | null;
}

export interface ChangeSet {
  book: BookId;
  games: BookGame[]; // games added or whose details changed
  changes: QuoteChange[];
  removedGames: string[]; // gameKeys this book no longer lists
}

/**
 * One in-memory board for every book. Adapters push snapshots or deltas; the store diffs them
 * and emits only what actually changed, so the browser receives deltas no matter whether a book
 * sends full snapshots (FanDuel) or deltas (DraftKings).
 */
export class OddsStore extends EventEmitter<{ change: [ChangeSet] }> {
  private quotes = new Map<string, Quote>();
  private games = new Map<string, BookGame>(); // `${book}|${gameKey}`

  applySnapshot(snap: BookSnapshot): ChangeSet {
    const seenQuotes = new Set<string>();
    const seenGames = new Set<string>();
    const set: ChangeSet = { book: snap.book, games: [], changes: [], removedGames: [] };

    for (const g of snap.games) {
      seenGames.add(g.gameKey);
      this.putGame(g, set);
    }
    for (const q of snap.quotes) {
      const key = quoteKey(q);
      seenQuotes.add(key);
      this.putQuote(key, q, set);
    }
    // Anything this book used to list and no longer does is gone.
    for (const [key, q] of this.quotes) {
      if (q.book === snap.book && !seenQuotes.has(key)) this.dropQuote(key, set);
    }
    for (const [k, g] of this.games) {
      if (g.book === snap.book && !seenGames.has(g.gameKey)) {
        this.games.delete(k);
        set.removedGames.push(g.gameKey);
      }
    }
    return this.emitIfAny(set);
  }

  applyDelta(delta: BookDelta): ChangeSet {
    const set: ChangeSet = { book: delta.book, games: [], changes: [], removedGames: [] };
    for (const g of delta.games ?? []) this.putGame(g, set);
    for (const q of delta.quotes) this.putQuote(quoteKey(q), q, set);
    for (const key of delta.removed ?? []) if (this.quotes.has(key)) this.dropQuote(key, set);
    return this.emitIfAny(set);
  }

  allQuotes(): Quote[] {
    return [...this.quotes.values()];
  }

  quote(key: string): Quote | undefined {
    return this.quotes.get(key);
  }

  allGames(): BookGame[] {
    return [...this.games.values()];
  }

  bookQuoteCount(book: BookId): number {
    let n = 0;
    for (const q of this.quotes.values()) if (q.book === book) n++;
    return n;
  }

  private putGame(g: BookGame, set: ChangeSet): void {
    const k = `${g.book}|${g.gameKey}`;
    const old = this.games.get(k);
    if (!old || old.live !== g.live || old.startTime !== g.startTime || JSON.stringify(old.score) !== JSON.stringify(g.score)) {
      set.games.push(g);
    }
    this.games.set(k, g);
  }

  private putQuote(key: string, q: Quote, set: ChangeSet): void {
    const old = this.quotes.get(key);
    // Ordering guard: never let an older reading overwrite a newer one (e.g. a slow poll vs a push).
    if (old && q.sourceTs < old.sourceTs && q.receivedTs <= old.receivedTs) return;
    if (old && old.american === q.american && old.line === q.line && old.suspended === q.suspended) {
      // Same price; keep the original change time so "last moved" stays honest.
      this.quotes.set(key, { ...q, sourceTs: old.sourceTs, receivedTs: old.receivedTs });
      return;
    }
    this.quotes.set(key, q);
    set.changes.push({ key, quote: q, prev: old ? { american: old.american, line: old.line, suspended: old.suspended } : null });
  }

  private dropQuote(key: string, set: ChangeSet): void {
    const old = this.quotes.get(key);
    this.quotes.delete(key);
    set.changes.push({ key, quote: null, prev: old ? { american: old.american, line: old.line, suspended: old.suspended } : null });
  }

  private emitIfAny(set: ChangeSet): ChangeSet {
    if (set.changes.length || set.games.length || set.removedGames.length) this.emit('change', set);
    return set;
  }
}
