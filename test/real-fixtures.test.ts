/**
 * Parsers vs payloads the books really sent. Record them with `npm run capture`; these tests are
 * skipped until the files exist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DkBoard } from '../src/books/draftkings/normalize.js';
import { FdBoard } from '../src/books/fanduel/normalize.js';
import { OddsStore } from '../src/core/store.js';
import { quoteKey } from '../src/core/types.js';

const f = (n: string) => `fixtures/${n}`;
const ts = { sourceTs: 1, receivedTs: 1 };
const have = (...names: string[]) => names.every((n) => existsSync(f(n)));

describe.runIf(have('dk-snapshot.json'))('real DraftKings snapshot', () => {
  it('maps every game with all three main markets and nothing invalid', () => {
    const b = new DkBoard();
    b.load(JSON.parse(readFileSync(f('dk-snapshot.json'), 'utf8')));
    const { games, quotes, missingEvents } = b.normalize(undefined, ts);
    expect(games.length).toBeGreaterThan(0);
    expect(missingEvents).toEqual([]);
    expect(b.invalid).toBe(0);
    for (const g of games) {
      const markets = new Set(quotes.filter((q) => q.gameKey === g.gameKey).map((q) => q.market));
      expect(markets.size, g.gameKey).toBeGreaterThan(0);
    }
  });
});

describe.runIf(have('dk-snapshot.json', 'dk-frames.jsonl'))('real DraftKings socket frames', () => {
  it('replaying every delta ends on exactly the board a fresh read of the same state gives', () => {
    const b = new DkBoard();
    b.load(JSON.parse(readFileSync(f('dk-snapshot.json'), 'utf8')));
    const store = new OddsStore();
    const first = b.normalize(undefined, ts);
    store.applySnapshot({ book: 'draftkings', ...first });
    const emitted = new Map<string, Set<string>>();
    const eventOf = new Map(first.games.map((g) => [g.gameKey, g.bookEventId]));
    for (const q of first.quotes) {
      const ev = eventOf.get(q.gameKey)!;
      (emitted.get(ev) ?? emitted.set(ev, new Set()).get(ev)!).add(quoteKey(q));
    }
    for (const line of readFileSync(f('dk-frames.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const m = JSON.parse(line);
      if (m.event !== 'update') continue;
      const r = b.apply(m.data.data);
      const n = b.normalize(r.touchedEvents, ts);
      const removed: string[] = [];
      for (const g of n.games) {
        const now = new Set(n.quotes.filter((q) => q.gameKey === g.gameKey).map((q) => quoteKey(q)));
        for (const k of emitted.get(g.bookEventId) ?? []) if (!now.has(k)) removed.push(k);
        emitted.set(g.bookEventId, now);
      }
      store.applyDelta({ book: 'draftkings', games: n.games, quotes: n.quotes, removed });
    }
    const truth = b.normalize(undefined, ts).quotes;
    const wrong = truth.filter((q) => {
      const s = store.quote(quoteKey(q));
      return !s || s.american !== q.american || s.line !== q.line || s.suspended !== q.suspended;
    });
    expect(wrong).toEqual([]);
    expect(store.allQuotes()).toHaveLength(truth.length);
  });
});

describe.runIf(have('fd-page.json'))('real FanDuel page and prices', () => {
  it('maps every game-line market and matches DraftKings game keys', () => {
    const b = new FdBoard();
    b.loadPage(JSON.parse(readFileSync(f('fd-page.json'), 'utf8')));
    if (have('fd-prices.json')) {
      const r = b.applyPrices(JSON.parse(readFileSync(f('fd-prices.json'), 'utf8')));
      expect(r.updated).toBeGreaterThan(0);
    }
    const { games, quotes } = b.normalize(ts);
    expect(games.length).toBeGreaterThan(0);
    expect(quotes.length).toBeGreaterThan(0);
    expect(b.invalid).toBe(0);
    if (have('dk-snapshot.json')) {
      const dk = new DkBoard();
      dk.load(JSON.parse(readFileSync(f('dk-snapshot.json'), 'utf8')));
      const dkKeys = new Set(dk.normalize(undefined, ts).games.map((g) => g.gameKey));
      const unmatched = games.filter((g) => !dkKeys.has(g.gameKey)).map((g) => g.gameKey);
      // Every FanDuel game should exist at DraftKings (DK usually lists more weeks ahead).
      expect(unmatched).toEqual([]);
    }
  });
});
