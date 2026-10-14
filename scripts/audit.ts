/**
 * Does the DraftKings push feed miss anything?
 * Builds a board from the socket ALONE (never re-synced) and compares it with a fresh REST read
 * every 5 s. A price that still differs on the next comparison counts as a miss (one comparison of
 * disagreement is allowed for the CDN cache and a push in flight).
 *   npm run audit                 (15 min; AUDIT_MINUTES=30 for longer, ideally during a live game)
 */
import WebSocket from 'ws';
import { DkBoard } from '../src/books/draftkings/normalize.js';
import { BROWSER_UA, config } from '../src/config.js';
import { quoteKey, type Quote } from '../src/core/types.js';

const minutes = Number(process.env.AUDIT_MINUTES ?? 15);
const url = config.dk.restUrl ?? `https://sportsbook-nash.draftkings.com/api/sportscontent/${config.dk.site}/v1/leagues/${config.dk.leagueId}`;
const ts = { sourceTs: 0, receivedTs: 0 };
const read = async () => {
  const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: 'https://sportsbook.draftkings.com', Referer: 'https://sportsbook.draftkings.com/' } });
  if (!r.ok) throw new Error(`REST ${r.status}`);
  return r.json();
};
const priceMap = (qs: Quote[]) => new Map(qs.map((q) => [quoteKey(q), `${q.line ?? ''}@${q.american}${q.suspended ? 'S' : ''}`]));

const first = await read();
const push = new DkBoard();
push.load(first);
const partials = Object.entries((first.subscriptionPartials ?? {}) as Record<string, { entity?: string; query?: string; includeMarkets?: string }>).filter(([, p]) => p.entity && p.query);

let frames = 0;
const ws = new WebSocket(config.dk.wsUrl, { headers: { 'User-Agent': BROWSER_UA, Origin: 'https://sportsbook.draftkings.com' } });
ws.on('open', () => {
  for (const [id, p] of partials) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', id, params: { entity: p.entity, queryParams: { query: p.query, ...(p.includeMarkets ? { includeMarkets: p.includeMarkets } : {}), initialData: false, projection: 'sportsbook', locale: 'en-US' }, forwardedHeaders: {}, clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': 'unknown' }, jwt: '', siteName: config.dk.site } }));
});
ws.on('message', (m) => {
  const j = JSON.parse(m.toString());
  if (j.event === 'update') {
    frames++;
    push.apply(j.data?.data ?? {});
  }
});

let restMoves = 0;
const firstBoard = new DkBoard();
firstBoard.load(first);
let lastRest = priceMap(firstBoard.normalize(undefined, ts).quotes);
let pendingDiff = new Set<string>();
const misses = new Set<string>();
let comparisons = 0;
let pushFirst = 0;

const end = Date.now() + minutes * 60_000;
console.log(`auditing the DraftKings push feed for ${minutes} min…`);
while (Date.now() < end) {
  await new Promise((r) => setTimeout(r, 5_000));
  let restBoard: DkBoard;
  try {
    restBoard = new DkBoard();
    restBoard.load(await read());
  } catch (e) {
    console.log(`  REST read failed: ${String(e)}`);
    continue;
  }
  comparisons++;
  const rest = priceMap(restBoard.normalize(undefined, ts).quotes);
  const pushed = priceMap(push.normalize(undefined, ts).quotes);
  for (const [k, v] of rest) {
    if (lastRest.get(k) !== v) {
      restMoves++;
      if (pushed.get(k) === v) pushFirst++;
    }
  }
  const diff = new Set([...rest].filter(([k, v]) => pushed.get(k) !== v).map(([k]) => k));
  for (const k of diff) if (pendingDiff.has(k)) misses.add(k);
  pendingDiff = diff;
  lastRest = rest;
  process.stdout.write(`\r  ${comparisons} comparisons · ${frames} socket frames · ${restMoves} price changes seen by REST · missed ${misses.size}   `);
}
ws.terminate();
console.log(`\n\nResult: ${restMoves} price changes, ${misses.size} missed by the push feed, ${pushFirst} already on the push board when REST first showed them.`);
for (const k of misses) console.log(`  missed: ${k}`);
process.exit(0);
