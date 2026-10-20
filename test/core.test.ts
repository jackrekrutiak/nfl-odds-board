import { describe, expect, it } from 'vitest';
import { compare, pickBest } from '../src/core/best.js';
import { parseAmerican, toOdds } from '../src/core/odds.js';
import { OddsStore } from '../src/core/store.js';
import { makeGameKey, resolveTeam } from '../src/core/teams.js';
import type { Quote } from '../src/core/types.js';

const q = (o: Partial<Quote>): Quote => ({
  book: 'draftkings', gameKey: 'g', market: 'spread', side: 'home', line: -3, american: -110, decimal: 1.909, suspended: false, sourceTs: 1, receivedTs: 1, ...o,
});

describe('teams', () => {
  it('resolves every spelling both books use', () => {
    for (const [raw, id] of [['DET Lions', 'DET'], ['Detroit Lions', 'DET'], ['LA Chargers', 'LAC'], ['Los Angeles Rams', 'LAR'], ['NY Jets', 'NYJ'], ['New York Giants', 'NYG'], ['SF 49ers', 'SF'], ['Washington Commanders', 'WAS'], ['TB Buccaneers', 'TB']] as const) {
      expect(resolveTeam(raw)?.id, raw).toBe(id);
    }
  });
  it('never guesses an unknown name', () => {
    expect(resolveTeam('Springfield Atoms')).toBeNull();
  });
  it('gives the same key across books even when kickoff differs by a minute', () => {
    const a = resolveTeam('DET Lions')!, h = resolveTeam('BUF Bills')!;
    expect(makeGameKey(a, h, Date.parse('2026-10-19T00:15:00Z'))).toBe(makeGameKey(a, h, Date.parse('2026-10-19T00:16:00Z')));
    expect(makeGameKey(a, h, Date.parse('2026-10-19T00:15:00Z'))).toBe('nfl:2026-10-18:DET@BUF'); // Sunday night, ET
  });
});

describe('odds', () => {
  it('parses the Unicode minus DraftKings uses', () => {
    expect(parseAmerican('−110')).toBe(-110);
    expect(parseAmerican('+120')).toBe(120);
    expect(parseAmerican('EVEN')).toBe(100);
  });
  it('prefers exact decimal but keeps the displayed American price', () => {
    expect(toOdds(1.90909091, '−110')).toEqual({ american: -110, decimal: 1.9091 });
    expect(toOdds(2.5, undefined)).toEqual({ american: 150, decimal: 2.5 });
  });
});

describe('best price', () => {
  it('same line: higher price wins', () => {
    expect(pickBest([q({ american: -110 }), q({ book: 'fanduel', american: -105 })])?.book).toBe('fanduel');
  });
  it('off a key number: -3 -110 beats -3.5 +100', () => {
    expect(compare(q({ line: -3, american: -110 }), q({ line: -3.5, american: 100 }))).toBeGreaterThan(0);
  });
  it('a half point between non-key numbers loses to a big price gap', () => {
    expect(compare(q({ line: -5.5, american: -105 }), q({ line: -6, american: 120 }))).toBeLessThan(0);
  });
  it('totals: over wants the lower number, under the higher', () => {
    expect(compare(q({ market: 'total', side: 'over', line: 44.5 }), q({ market: 'total', side: 'over', line: 45 }))).toBeGreaterThan(0);
    expect(compare(q({ market: 'total', side: 'under', line: 45 }), q({ market: 'total', side: 'under', line: 44.5 }))).toBeGreaterThan(0);
  });
  it('ignores suspended prices', () => {
    expect(pickBest([q({ american: 200, suspended: true }), q({ book: 'fanduel', american: -110 })])?.book).toBe('fanduel');
    expect(pickBest([q({ suspended: true })])).toBeNull();
  });
});

describe('store', () => {
  it('turns full snapshots into deltas', () => {
    const s = new OddsStore();
    const snap = (american: number) => ({ book: 'fanduel' as const, games: [], quotes: [q({ book: 'fanduel', american })] });
    expect(s.applySnapshot(snap(-110)).changes).toHaveLength(1);
    expect(s.applySnapshot(snap(-110)).changes).toHaveLength(0);
    const c = s.applySnapshot(snap(-115)).changes[0]!;
    expect(c.prev?.american).toBe(-110);
    expect(c.quote?.american).toBe(-115);
  });
  it('removes what a snapshot no longer lists, for that book only', () => {
    const s = new OddsStore();
    s.applySnapshot({ book: 'fanduel', games: [], quotes: [q({ book: 'fanduel' })] });
    s.applySnapshot({ book: 'draftkings', games: [], quotes: [q({})] });
    const c = s.applySnapshot({ book: 'fanduel', games: [], quotes: [] });
    expect(c.changes).toHaveLength(1);
    expect(s.allQuotes().map((x) => x.book)).toEqual(['draftkings']);
  });
  it('does not let an older reading overwrite a newer one', () => {
    const s = new OddsStore();
    s.applyDelta({ book: 'draftkings', quotes: [q({ american: -120, sourceTs: 100, receivedTs: 100 })] });
    s.applyDelta({ book: 'draftkings', quotes: [q({ american: -110, sourceTs: 50, receivedTs: 90 })] });
    expect(s.allQuotes()[0]!.american).toBe(-120);
  });
});

import { playerKey } from '../src/core/players.js';
describe('player keys', () => {
  it('match however a book spells the name', () => {
    expect(playerKey("D'Andre Swift")).toBe('dandre-swift');
    expect(playerKey('A.J. Brown')).toBe('aj-brown');
    expect(playerKey('Luther Burden III')).toBe(playerKey('Luther Burden'));
    expect(playerKey('Kenneth Walker Jr.')).toBe('kenneth-walker');
  });
});
