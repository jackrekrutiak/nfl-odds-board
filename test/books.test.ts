import { describe, expect, it } from 'vitest';
import { DkBoard, marketTypeOf } from '../src/books/draftkings/normalize.js';
import { FdBoard } from '../src/books/fanduel/normalize.js';

const ts = { sourceTs: 1, receivedTs: 1 };

function dkSnapshot() {
  return {
    events: [{ id: '1', name: 'DET Lions @ BUF Bills', startEventDate: '2026-10-19T00:15:00.0000000Z', status: 'NOT_STARTED', participants: [{ name: 'DET Lions', venueRole: 'Away' }, { name: 'BUF Bills', venueRole: 'Home' }] }],
    markets: [
      { id: 'm1', eventId: '1', name: 'Moneyline', marketType: { name: 'Moneyline' } },
      { id: 'm2', eventId: '1', name: 'Spread', marketType: { name: 'Spread' } },
      { id: 'm3', eventId: '1', name: 'Total', marketType: { name: 'Total' } },
      { id: 'm4', eventId: '1', name: 'Alternate Spread', marketType: { name: 'Alternate Spread' } },
    ],
    selections: [
      { id: 's1', marketId: 'm1', label: 'DET Lions', outcomeType: 'Away', trueOdds: 2.3, displayOdds: { american: '+130' } },
      { id: 's2', marketId: 'm1', label: 'BUF Bills', outcomeType: 'Home', trueOdds: 1.667, displayOdds: { american: '−150' } },
      { id: 's3', marketId: 'm2', label: 'DET Lions', outcomeType: 'Away', points: 2.5, trueOdds: 1.909, displayOdds: { american: '−110' } },
      { id: 's4', marketId: 'm2', label: 'BUF Bills', outcomeType: 'Home', points: -2.5, trueOdds: 1.909, displayOdds: { american: '−110' } },
      { id: 's5', marketId: 'm3', label: 'Over', outcomeType: 'Over', points: 51.5, trueOdds: 1.909, displayOdds: { american: '−110' } },
      { id: 's6', marketId: 'm3', label: 'Under', outcomeType: 'Under', points: 51.5, trueOdds: 1.909, displayOdds: { american: '−110' } },
      { id: 's7', marketId: 'm4', label: 'BUF Bills', outcomeType: 'Home', points: -7.5, trueOdds: 3, displayOdds: { american: '+200' } },
    ],
  };
}

describe('DraftKings', () => {
  it('maps the snapshot to game, market, side, line, odds (main lines only)', () => {
    const b = new DkBoard();
    b.load(dkSnapshot());
    const { games, quotes } = b.normalize(undefined, ts);
    expect(games).toHaveLength(1);
    expect(games[0]!.gameKey).toBe('nfl:2026-10-18:DET@BUF');
    expect(quotes).toHaveLength(6); // alternate spread ignored
    const home = quotes.find((q) => q.market === 'spread' && q.side === 'home')!;
    expect(home).toMatchObject({ line: -2.5, american: -110 });
  });

  it('merges partial changes (no marketId on a price change)', () => {
    const b = new DkBoard();
    b.load(dkSnapshot());
    const r = b.apply({ change: { selections: [{ id: 's2', trueOdds: 1.588, displayOdds: { american: '−170' } }] } });
    expect([...r.touchedEvents]).toEqual(['1']);
    expect(r.unresolved).toBe(0);
    const ml = b.normalize(r.touchedEvents, ts).quotes.find((q) => q.market === 'moneyline' && q.side === 'home')!;
    expect(ml.american).toBe(-170);
  });

  it('follows a line move: new selection id with replacedSelectionId and no marketId', () => {
    const b = new DkBoard();
    b.load(dkSnapshot());
    const r = b.apply({ add: { selections: [{ id: 's5b', replacedSelectionId: 's5', points: 52.5, trueOdds: 1.952, displayOdds: { american: '−105' } }] } });
    const over = b.normalize(r.touchedEvents, ts).quotes.filter((q) => q.market === 'total' && q.side === 'over');
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ line: 52.5, american: -105 });
  });

  it('handles remove + add and market suspension', () => {
    const b = new DkBoard();
    b.load(dkSnapshot());
    b.apply({ remove: { selections: ['s3'] }, change: { markets: [{ id: 'm2', isSuspended: true }] } });
    const quotes = b.normalize(undefined, ts).quotes.filter((q) => q.market === 'spread');
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.suspended).toBe(true);
  });

  it('flags changes it cannot place so the adapter resyncs', () => {
    const b = new DkBoard();
    b.load(dkSnapshot());
    expect(b.apply({ change: { selections: [{ id: 'nope', trueOdds: 2 }] } }).unresolved).toBe(1);
  });

  it('drops malformed records instead of failing', () => {
    const b = new DkBoard();
    b.load({ ...dkSnapshot(), selections: [...dkSnapshot().selections, null, { marketId: 'm1' }, { id: 'x', marketId: 'm1', outcomeType: 'Home' }] });
    expect(b.normalize(undefined, ts).quotes).toHaveLength(6);
    expect(b.invalid).toBeGreaterThan(0);
  });

  it('classifies market names', () => {
    expect(marketTypeOf({ name: 'Total', marketType: { name: 'Total' } })).toBe('total');
    expect(marketTypeOf({ name: 'Team Total Points' })).toBeNull();
    expect(marketTypeOf({ name: '1st Half Spread' })).toBeNull();
  });
});

function fdPage(american = -110) {
  const odds = (a: number) => ({ americanDisplayOdds: { americanOdds: a }, trueOdds: { decimalOdds: { decimalOdds: a > 0 ? 1 + a / 100 : 1 + 100 / -a } } });
  return {
    attachments: {
      events: { 9: { eventId: 9, name: 'Detroit Lions @ Buffalo Bills', openDate: '2026-10-19T00:16:00.000Z' } },
      markets: {
        'a.1': { marketId: 'a.1', eventId: 9, marketType: 'MONEY_LINE', marketStatus: 'OPEN', runners: [{ selectionId: 1, handicap: 0, result: { type: 'AWAY' }, runnerStatus: 'ACTIVE', winRunnerOdds: odds(125) }, { selectionId: 2, handicap: 0, result: { type: 'HOME' }, runnerStatus: 'ACTIVE', winRunnerOdds: odds(-145) }] },
        'a.2': { marketId: 'a.2', eventId: 9, marketType: 'MATCH_HANDICAP_(2-WAY)', marketStatus: 'OPEN', runners: [{ selectionId: 1, handicap: 3, result: { type: 'AWAY' }, runnerStatus: 'ACTIVE', winRunnerOdds: odds(american) }, { selectionId: 2, handicap: -3, result: { type: 'HOME' }, runnerStatus: 'ACTIVE', winRunnerOdds: odds(-110) }] },
        'a.9': { marketId: 'a.9', eventId: 1, marketType: 'NFL_CHAMPIONSHIP_WINNER', runners: [] },
      },
    },
  };
}

describe('FanDuel', () => {
  it('reads main markets, ignores futures, and matches DK game keys', () => {
    const b = new FdBoard();
    b.loadPage(fdPage());
    const { games, quotes } = b.normalize(ts);
    expect(games.map((g) => g.gameKey)).toEqual(['nfl:2026-10-18:DET@BUF']);
    expect(quotes).toHaveLength(4);
    expect(b.invalid).toBe(0);
  });

  it('overlays the price channel, including a line move', () => {
    const b = new FdBoard();
    b.loadPage(fdPage());
    const r = b.applyPrices([{ marketId: 'a.2', marketStatus: 'OPEN', runnerDetails: [{ selectionId: 1, handicap: 3.5, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOdds: -120 } } }] }]);
    expect(r).toEqual({ unknown: 0, updated: 1 });
    expect(b.normalize(ts).quotes.find((q) => q.market === 'spread' && q.side === 'away')).toMatchObject({ line: 3.5, american: -120 });
  });

  it('keeps price-channel numbers over a stale cached page only while the channel is healthy', () => {
    const b = new FdBoard();
    b.loadPage(fdPage(-110));
    b.applyPrices([{ marketId: 'a.2', runnerDetails: [{ selectionId: 1, handicap: 3, winRunnerOdds: { americanDisplayOdds: { americanOdds: -125 } } }] }]);
    b.loadPage(fdPage(-110), true);
    expect(b.normalize(ts).quotes.find((q) => q.market === 'spread' && q.side === 'away')!.american).toBe(-125);
    b.loadPage(fdPage(-110), false);
    expect(b.normalize(ts).quotes.find((q) => q.market === 'spread' && q.side === 'away')!.american).toBe(-110);
  });

  it('reports unknown selections (re-keyed after a line move) and suspension', () => {
    const b = new FdBoard();
    b.loadPage(fdPage());
    const r = b.applyPrices([{ marketId: 'a.1', marketStatus: 'SUSPENDED', runnerDetails: [{ selectionId: 77, winRunnerOdds: {} }] }]);
    expect(r.unknown).toBe(1);
    expect(b.normalize(ts).quotes.filter((q) => q.market === 'moneyline').every((q) => q.suspended)).toBe(true);
  });
});
