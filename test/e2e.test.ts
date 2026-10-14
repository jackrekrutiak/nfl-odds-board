/**
 * End-to-end: the real server and real adapters against mock DraftKings + FanDuel endpoints,
 * read through the same SSE stream the browser uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockBooks, type MockBooks } from '../scripts/mock-books.js';

let mock: MockBooks;
let base: string;
let app: { server: import('node:http').Server; close: () => void };

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const metrics = async () => (await fetch(`${base}/api/metrics`)).json() as Promise<{ health: Array<{ book: string; state: string }> }>;
const board = async () => (await fetch(`${base}/api/board`)).json() as Promise<{ quotes: Array<{ book: string; gameKey: string; market: string; side: string; american: number; line: number | null }> }>;
const stateOf = async (book: string) => (await metrics()).health.find((h) => h.book === book)?.state;

beforeAll(async () => {
  mock = await startMockBooks(0);
  const m = `http://127.0.0.1:${mock.port}`;
  Object.assign(process.env, {
    PORT: '0', DK_REST_URL: `${m}/dk/leagues`, DK_WS_URL: `ws://127.0.0.1:${mock.port}/dk/ws`, FD_PAGE_URL: `${m}/fd/page`, FD_PRICES_URL: `${m}/fd/prices`,
    FD_PRICES_MS: '600', FD_LIVE_PRICES_MS: '150', FD_PAGE_MS: '1000', STALE_AFTER_MS: '1500', DK_WS_FALLBACK_AFTER_MS: '300', DK_POLL_MS: '300', HEARTBEAT_MS: '200',
  });
  const { buildApp } = await import('../src/server/main.js');
  app = buildApp();
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  app?.close();
  await mock?.close();
});

describe('end to end', () => {
  it('boots both books into one normalized board', async () => {
    await until(async () => (await stateOf('draftkings')) === 'live' && (await stateOf('fanduel')) === 'live');
    const b = await board();
    expect(b.quotes.filter((q) => q.book === 'draftkings')).toHaveLength(36);
    expect(b.quotes.filter((q) => q.book === 'fanduel')).toHaveLength(36);
    const dkKeys = new Set(b.quotes.filter((q) => q.book === 'draftkings').map((q) => q.gameKey));
    const fdKeys = new Set(b.quotes.filter((q) => q.book === 'fanduel').map((q) => q.gameKey));
    expect([...dkKeys].sort()).toEqual([...fdKeys].sort());
  });

  it('pushes a DraftKings move to an SSE viewer without a refresh', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    let buf = '';
    const read = async (needle: string) => {
      const dec = new TextDecoder();
      while (!buf.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += dec.decode(value);
      }
    };
    await read('event: snapshot');
    mock.dkMove(1, -175);
    await read('"american":-175');
    expect(buf).toContain('event: delta');
    ctrl.abort();
  });

  it('follows a DraftKings line move (re-keyed selection)', async () => {
    mock.dkLineMove(4, 52.5, -105); // first game's Over 51.5 → 52.5
    const q = await until(async () => (await board()).quotes.find((x) => x.book === 'draftkings' && x.market === 'total' && x.side === 'over' && x.line === 52.5));
    expect(q.american).toBe(-105);
  });

  it('picks up a FanDuel move through the price channel', async () => {
    mock.fdMove(0, 0, 160);
    await until(async () => (await board()).quotes.find((x) => x.book === 'fanduel' && x.market === 'moneyline' && x.american === 160));
  });

  it('polls in-game FanDuel markets faster than pregame ones', async () => {
    mock.fdSetInPlay(2);
    // The price channel learns a game is in play from its own answer, then splits the cadence.
    await until(async () => ((await metrics()) as unknown as { books: { fanduel: { liveMarkets: number } } }).books.fanduel.liveMarkets > 0);
    const liveId = '801.350000021';
    const pregameId = '801.350000001';
    const from = mock.fdPriceRequests.length;
    await new Promise((r) => setTimeout(r, 1300));
    const reqs = mock.fdPriceRequests.slice(from);
    const liveHits = reqs.filter((ids) => ids.includes(liveId)).length;
    const pregameHits = reqs.filter((ids) => ids.includes(pregameId)).length;
    expect(liveHits).toBeGreaterThan(pregameHits);
  });

  it('keeps FanDuel updating while DraftKings is down, and says DraftKings is stale', async () => {
    mock.set('dk-ws', false);
    mock.set('dk-rest', false);
    await until(async () => (await stateOf('draftkings')) === 'stale' || (await stateOf('draftkings')) === 'degraded', 10_000);
    mock.fdMove(0, 0, 175);
    await until(async () => (await board()).quotes.find((x) => x.book === 'fanduel' && x.american === 175));
    expect(await stateOf('fanduel')).toBe('live');
    // DK's last numbers are still served (greyed in the UI), not dropped…
    expect((await board()).quotes.filter((q) => q.book === 'draftkings').length).toBeGreaterThan(0);
    // …but a stale book can't win best price.
    const best = Object.values(((await (await fetch(`${base}/api/board`)).json()) as { best: Record<string, string | null> }).best);
    expect(best.length).toBeGreaterThan(0);
    expect(best.every((k) => k === null || k.endsWith('|fanduel'))).toBe(true);
  });

  it('keeps a fully down FanDuel unhealthy (never flips back to a fallback state)', async () => {
    mock.set('fd', false);
    await until(async () => ['degraded', 'stale'].includes((await stateOf('fanduel')) ?? ''));
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      seen.add((await stateOf('fanduel')) ?? '');
      await new Promise((r) => setTimeout(r, 250));
    }
    expect([...seen].filter((s) => s === 'polling' || s === 'live')).toEqual([]);
    mock.set('fd', true);
    await until(async () => (await stateOf('fanduel')) === 'live', 10_000);
  });

  it('recovers DraftKings when it comes back', async () => {
    mock.set('dk-rest', true);
    mock.set('dk-ws', true);
    await until(async () => (await stateOf('draftkings')) === 'live', 20_000);
  }, 25_000);
});
