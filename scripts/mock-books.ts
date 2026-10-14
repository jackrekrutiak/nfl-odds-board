/**
 * Local stand-ins for DraftKings and FanDuel that speak the same shapes as the real endpoints:
 *   DK  GET /dk/leagues            (REST snapshot with subscriptionPartials)
 *   DK  WS  /dk/ws                 (JSON-RPC subscribe → "subscribed" → "update" deltas)
 *   FD  GET /fd/page               (content-managed-page, with ETag / 304)
 *   FD  POST /fd/prices            (getMarketPrices)
 * Used by `npm run demo` and the end-to-end test, so the real adapters run without touching the books.
 * Control endpoints let tests break things: POST /control/{dk-rest|dk-ws|fd}/{up|down}.
 */
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

const MATCHUPS: Array<[string, string, string, string, number, number]> = [
  // DK away name, DK home name, FD away, FD home, spread (home), total
  ['DET Lions', 'BUF Bills', 'Detroit Lions', 'Buffalo Bills', -2.5, 51.5],
  ['KC Chiefs', 'BAL Ravens', 'Kansas City Chiefs', 'Baltimore Ravens', -3, 47.5],
  ['LA Chargers', 'NY Jets', 'Los Angeles Chargers', 'New York Jets', 1.5, 41.5],
  ['SF 49ers', 'SEA Seahawks', 'San Francisco 49ers', 'Seattle Seahawks', 3.5, 44.5],
  ['PHI Eagles', 'DAL Cowboys', 'Philadelphia Eagles', 'Dallas Cowboys', 4, 46],
  ['GB Packers', 'CHI Bears', 'Green Bay Packers', 'Chicago Bears', 1, 43.5],
];

interface Sel { id: string; marketId: string; outcome: 'Home' | 'Away' | 'Over' | 'Under'; label: string; points?: number; american: number }

export interface MockBooks {
  server: Server;
  port: number;
  dk: { events: Record<string, unknown>[]; markets: Record<string, unknown>[]; selections: Sel[] };
  /** Move a DK price (pushes a delta). */
  dkMove(selIndex: number, american: number): void;
  /** Move a DK line (new selection id, replacedSelectionId). */
  dkLineMove(selIndex: number, points: number, american: number): void;
  fdMove(marketIndex: number, runnerIndex: number, american: number): void;
  /** Put one game's FanDuel markets in play. */
  fdSetInPlay(gameIndex: number): void;
  /** Every getMarketPrices request body seen, as market-id lists. */
  fdPriceRequests: string[][];
  set(target: 'dk-rest' | 'dk-ws' | 'fd', up: boolean): void;
  close(): Promise<void>;
}

const dec = (a: number) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const disp = (a: number) => (a > 0 ? `+${a}` : `−${-a}`); // DK uses a Unicode minus

export async function startMockBooks(port = 0, opts: { autoMove?: boolean } = {}): Promise<MockBooks> {
  const start = Date.now() + 2 * 86_400_000;
  const events: Record<string, unknown>[] = [];
  const markets: Record<string, unknown>[] = [];
  const sels: Sel[] = [];
  const fdEvents: Record<string, unknown> = {};
  const fdMarkets: Record<string, { marketId: string; eventId: number; marketType: string; marketStatus: string; inPlay: boolean; runners: Record<string, unknown>[] }> = {};

  MATCHUPS.forEach(([dkA, dkH, fdA, fdH, spread, total], i) => {
    const evId = String(30000 + i);
    const t = new Date(start + i * 3 * 3_600_000).toISOString().replace('Z', '0000Z'); // 7 fractional digits like DK
    events.push({ id: evId, name: `${dkA} @ ${dkH}`, startEventDate: t, status: 'NOT_STARTED', participants: [{ name: dkA, venueRole: 'Away' }, { name: dkH, venueRole: 'Home' }] });
    const ml = `1_${evId}`, sp = `2_${evId}`, to = `3_${evId}`;
    markets.push({ id: ml, eventId: evId, name: 'Moneyline', marketType: { name: 'Moneyline' } });
    markets.push({ id: sp, eventId: evId, name: 'Spread', marketType: { name: 'Spread' } });
    markets.push({ id: to, eventId: evId, name: 'Total', marketType: { name: 'Total' } });
    const fav = spread < 0 ? -150 : 130;
    sels.push({ id: `0ML${evId}_1`, marketId: ml, outcome: 'Away', label: dkA, american: -fav > 0 ? 130 : -150 });
    sels.push({ id: `0ML${evId}_3`, marketId: ml, outcome: 'Home', label: dkH, american: fav });
    sels.push({ id: `0HC${evId}A${Math.abs(spread * 10)}_1`, marketId: sp, outcome: 'Away', label: dkA, points: -spread, american: -110 });
    sels.push({ id: `0HC${evId}H${Math.abs(spread * 10)}_3`, marketId: sp, outcome: 'Home', label: dkH, points: spread, american: -110 });
    sels.push({ id: `0OU${evId}O${total * 10}_1`, marketId: to, outcome: 'Over', label: 'Over', points: total, american: -112 });
    sels.push({ id: `0OU${evId}U${total * 10}_3`, marketId: to, outcome: 'Under', label: 'Under', points: total, american: -108 });

    const fdEv = 35000000 + i;
    fdEvents[fdEv] = { eventId: fdEv, name: `${fdA} @ ${fdH}`, openDate: new Date(start + i * 3 * 3_600_000 + 60_000).toISOString() };
    const runner = (sid: number, name: string, type: string, handicap: number, american: number) => ({
      selectionId: sid, runnerName: name, handicap, result: { type }, runnerStatus: 'ACTIVE',
      winRunnerOdds: { americanDisplayOdds: { americanOdds: american }, trueOdds: { decimalOdds: { decimalOdds: dec(american) } } },
    });
    const off = (n: number) => n + (i % 2 ? 5 : -5); // FD a few cents off DK, so "best" varies
    fdMarkets[`801.${fdEv}1`] = { marketId: `801.${fdEv}1`, eventId: fdEv, marketType: 'MONEY_LINE', marketStatus: 'OPEN', inPlay: false, runners: [runner(i * 10 + 1, fdA, 'AWAY', 0, spread < 0 ? 125 : -155), runner(i * 10 + 2, fdH, 'HOME', 0, spread < 0 ? -145 : 135)] };
    fdMarkets[`801.${fdEv}2`] = { marketId: `801.${fdEv}2`, eventId: fdEv, marketType: 'MATCH_HANDICAP_(2-WAY)', marketStatus: 'OPEN', inPlay: false, runners: [runner(i * 10 + 1, fdA, 'AWAY', -spread + (i === 1 ? -0.5 : 0), off(-110)), runner(i * 10 + 2, fdH, 'HOME', spread + (i === 1 ? 0.5 : 0), -110)] };
    fdMarkets[`801.${fdEv}3`] = { marketId: `801.${fdEv}3`, eventId: fdEv, marketType: 'TOTAL_POINTS_(OVER/UNDER)', marketStatus: 'OPEN', inPlay: false, runners: [runner(i * 10 + 3, 'Over', 'OVER', total, -110), runner(i * 10 + 4, 'Under', 'UNDER', total, -110)] };
  });
  // Futures market FD mixes into the page: must be ignored.
  fdMarkets['801.999'] = { marketId: '801.999', eventId: 1, marketType: 'NFL_CHAMPIONSHIP_WINNER', marketStatus: 'OPEN', inPlay: false, runners: [] };

  const up = { 'dk-rest': true, 'dk-ws': true, fd: true };
  let fdVersion = 1;
  const sockets = new Set<WebSocket>();

  const dkSel = (s: Sel) => ({ id: s.id, marketId: s.marketId, label: s.label, outcomeType: s.outcome, ...(s.points !== undefined ? { points: s.points } : {}), trueOdds: dec(s.american), displayOdds: { american: disp(s.american) } });
  const fdPage = () => ({ attachments: { events: fdEvents, markets: fdMarkets } });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const ctl = url.pathname.match(/^\/control\/(dk-rest|dk-ws|fd)\/(up|down)$/);
    if (ctl) {
      api.set(ctl[1] as 'dk-rest', ctl[2] === 'up');
      return send(200, { ok: true });
    }
    if (url.pathname === '/dk/leagues') {
      if (!up['dk-rest']) return send(403, '<html>Access Denied</html>', { 'Content-Type': 'text/html' });
      return send(200, {
        events, markets, selections: sels.map(dkSel),
        subscriptionPartials: { 'league-markets-88808': { entity: 'markets', query: "$filter=leagueId eq '88808'" } },
      });
    }
    if (url.pathname === '/fd/page') {
      if (!up.fd) return send(503, 'down');
      const etag = `"v${fdVersion}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
      return send(200, fdPage(), { ETag: etag, 'Cache-Control': 'max-age=30' });
    }
    if (url.pathname === '/fd/prices' && req.method === 'POST') {
      if (!up.fd) return send(503, 'down');
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const ids: string[] = JSON.parse(body || '{}').marketIds ?? [];
        api.fdPriceRequests.push(ids);
        send(200, ids.filter((id) => fdMarkets[id]).map((id) => ({ marketId: id, marketStatus: fdMarkets[id]!.marketStatus, inplay: fdMarkets[id]!.inPlay, runnerDetails: fdMarkets[id]!.runners })), { 'Cache-Control': 'no-cache' });
      });
      return;
    }
    send(404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!up['dk-ws'] || !req.url?.startsWith('/dk/ws')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', (m) => {
        const msg = JSON.parse(m.toString());
        if (msg.method === 'subscribe') ws.send(JSON.stringify({ id: msg.id, event: 'subscribed', websocketPublishTimestamp: new Date().toISOString() }));
      });
    });
  });

  const push = (data: unknown) => {
    const created = new Date(Date.now() - 40).toISOString();
    const frame = JSON.stringify({ id: 'league-markets-88808', event: 'update', data: { data, metadata: { createdTime: created, publishedTime: created } }, websocketPublishTimestamp: new Date().toISOString() });
    for (const s of sockets) s.send(frame);
  };

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  let timer: NodeJS.Timeout | null = null;
  const api: MockBooks = {
    server,
    port: actualPort,
    dk: { events, markets, selections: sels },
    dkMove(i, american) {
      const s = sels[i]!;
      s.american = american;
      push({ change: { selections: [{ id: s.id, trueOdds: dec(american), displayOdds: { american: disp(american) } }] } });
    },
    dkLineMove(i, points, american) {
      const s = sels[i]!;
      const oldId = s.id;
      s.id = `${oldId.split('_')[0]}x${Math.round(points * 10)}_${oldId.split('_')[1]}`;
      s.points = points;
      s.american = american;
      push({ add: { selections: [{ id: s.id, replacedSelectionId: oldId, points, trueOdds: dec(american), displayOdds: { american: disp(american) } }] } });
    },
    fdMove(mi, ri, american) {
      const m = Object.values(fdMarkets)[mi]!;
      const r = m.runners[ri] as { winRunnerOdds: unknown };
      r.winRunnerOdds = { americanDisplayOdds: { americanOdds: american }, trueOdds: { decimalOdds: { decimalOdds: dec(american) } } };
      fdVersion++;
    },
    fdSetInPlay(gi) {
      const ev = 35000000 + gi;
      for (const m of Object.values(fdMarkets)) if (m.eventId === ev) m.inPlay = true;
      fdVersion++;
    },
    fdPriceRequests: [],
    set(target, isUp) {
      up[target] = isUp;
      if (target === 'dk-ws' && !isUp) for (const s of sockets) s.terminate();
    },
    async close() {
      if (timer) clearInterval(timer);
      for (const s of sockets) s.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  if (opts.autoMove) {
    const ladder = [-105, -108, -110, -112, -115, -118, -120];
    timer = setInterval(() => {
      const r = Math.random();
      if (r < 0.6) api.dkMove(Math.floor(Math.random() * sels.length), ladder[Math.floor(Math.random() * ladder.length)]!);
      else api.fdMove(Math.floor(Math.random() * MATCHUPS.length * 3), Math.floor(Math.random() * 2), ladder[Math.floor(Math.random() * ladder.length)]!);
    }, 1500);
  }
  return api;
}

if (process.argv[1]?.endsWith('mock-books.ts')) {
  const port = Number(process.env.MOCK_PORT ?? 4100);
  startMockBooks(port, { autoMove: true }).then((m) => console.log(`mock books on http://127.0.0.1:${m.port}`));
}
