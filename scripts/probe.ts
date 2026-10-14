/**
 * "Can this machine reach the books?" Run it on your laptop and on the host before deploying.
 *   npm run probe            (uses REGION from env, default us)
 *   REGION=ca npm run probe
 * It never runs in CI. It makes 1 DK REST call, holds the DK socket for 20 s, and makes
 * 1 FanDuel page call + 1 price call.
 */
import WebSocket from 'ws';
import { BROWSER_UA, config } from '../src/config.js';

const line = (ok: boolean, what: string, detail: string) => console.log(`${ok ? '✅' : '❌'} ${what.padEnd(22)} ${detail}`);

async function timed(url: string, init: RequestInit = {}) {
  const t = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  return { res, text, ms: Date.now() - t };
}

console.log(`region preset: ${config.region}\n`);

// DraftKings REST
let partials: Record<string, { entity: string; query: string; includeMarkets?: string }> = {};
const dkUrl = config.dk.restUrl ?? `https://sportsbook-nash.draftkings.com/api/sportscontent/${config.dk.site}/v1/leagues/${config.dk.leagueId}`;
try {
  const { res, text, ms } = await timed(dkUrl, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: 'https://sportsbook.draftkings.com', Referer: 'https://sportsbook.draftkings.com/' } });
  if (res.ok) {
    const j = JSON.parse(text);
    partials = j.subscriptionPartials ?? {};
    line(true, 'DraftKings REST', `${res.status} in ${ms} ms · ${(text.length / 1024).toFixed(0)} KB · ${j.events?.length ?? 0} events, ${j.markets?.length ?? 0} markets · cache-control: ${res.headers.get('cache-control')}`);
  } else line(false, 'DraftKings REST', `${res.status} in ${ms} ms · ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
} catch (e) {
  line(false, 'DraftKings REST', String(e));
}

// DraftKings socket
await new Promise<void>((resolve) => {
  const ws = new WebSocket(config.dk.wsUrl, { headers: { 'User-Agent': BROWSER_UA, Origin: 'https://sportsbook.draftkings.com' } });
  let acked = false;
  let frames = 0;
  const lat: number[] = [];
  const done = () => {
    ws.terminate();
    const s = lat.sort((a, b) => a - b);
    line(acked, 'DraftKings socket', acked ? `subscribed · ${frames} update frames in 20 s${s.length ? ` · createdTime→here p50 ${s[Math.floor(s.length / 2)]} ms (uncorrected for clock skew)` : ''}` : 'no subscription ack');
    resolve();
  };
  const timer = setTimeout(done, 20_000);
  ws.on('open', () => {
    const list = Object.entries(partials);
    if (!list.length) list.push([`league-${config.dk.leagueId}`, { entity: 'events', query: `$filter=leagueId eq '${config.dk.leagueId}'` }]);
    for (const [id, p] of list) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', id, params: { entity: p.entity, queryParams: { query: p.query, ...(p.includeMarkets ? { includeMarkets: p.includeMarkets } : {}), initialData: false, projection: 'sportsbook', locale: 'en-US' }, forwardedHeaders: {}, clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': 'unknown' }, jwt: '', siteName: config.dk.site } }));
  });
  ws.on('message', (m) => {
    const j = JSON.parse(m.toString());
    if (j.event === 'subscribed') acked = true;
    if (j.event === 'update') {
      frames++;
      const c = Date.parse(String(j.data?.metadata?.createdTime ?? '').replace(/(\.\d{3})\d+/, '$1'));
      if (Number.isFinite(c)) lat.push(Date.now() - c);
    }
  });
  ws.on('error', (e) => {
    clearTimeout(timer);
    line(false, 'DraftKings socket', e.message);
    resolve();
  });
});

// FanDuel page
let marketIds: string[] = [];
try {
  const u = new URL(config.fd.pageUrl);
  u.search = new URLSearchParams({ page: 'CUSTOM', customPageId: config.fd.pageId, _ak: config.fd.apiKey, timezone: 'America/New_York' }).toString();
  const { res, text, ms } = await timed(u.toString(), { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: config.fd.origin, Referer: `${config.fd.origin}/` } });
  if (res.ok) {
    const j = JSON.parse(text);
    const markets = Object.values(j.attachments?.markets ?? {}) as Array<{ marketId: string; marketType: string }>;
    marketIds = markets.filter((m) => ['MONEY_LINE', 'MATCH_HANDICAP_(2-WAY)', 'TOTAL_POINTS_(OVER/UNDER)'].includes(m.marketType)).map((m) => m.marketId);
    line(true, 'FanDuel page', `${res.status} in ${ms} ms · ${(text.length / 1024).toFixed(0)} KB · ${marketIds.length} game-line markets · cache-control: ${res.headers.get('cache-control')} · age: ${res.headers.get('age')}`);
  } else line(false, 'FanDuel page', `${res.status} in ${ms} ms · ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
} catch (e) {
  line(false, 'FanDuel page', String(e));
}

// FanDuel prices
if (marketIds.length) {
  try {
    const { res, text, ms } = await timed(config.fd.pricesUrl, { method: 'POST', headers: { 'User-Agent': BROWSER_UA, 'Content-Type': 'application/json', Accept: 'application/json', Origin: config.fd.origin, Referer: `${config.fd.origin}/` }, body: JSON.stringify({ marketIds: marketIds.slice(0, 70) }) });
    const n = res.ok ? (JSON.parse(text) as unknown[]).length : 0;
    line(res.ok && n > 0, 'FanDuel prices', `${res.status} in ${ms} ms · ${n}/${Math.min(70, marketIds.length)} markets · cache-control: ${res.headers.get('cache-control')}`);
  } catch (e) {
    line(false, 'FanDuel prices', String(e));
  }
}
