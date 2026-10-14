/**
 * Record real payloads from both books into fixtures/, so the parsers are tested against what the
 * books actually send (test/real-fixtures.test.ts runs whenever these files exist).
 *   npm run capture            (REGION=ca for Ontario; ~60 s on the DraftKings socket)
 *   CAPTURE_SECONDS=300 npm run capture   (longer: more line moves, ideally during a live game)
 * Makes 1 DK REST call, holds 1 DK socket, 1 FD page call and 1-2 FD price calls.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { BROWSER_UA, config } from '../src/config.js';

const seconds = Number(process.env.CAPTURE_SECONDS ?? 60);
mkdirSync('fixtures', { recursive: true });
const save = (name: string, data: string) => {
  writeFileSync(`fixtures/${name}`, data);
  console.log(`saved fixtures/${name} (${(data.length / 1024).toFixed(0)} KB)`);
};

// DraftKings snapshot
const dkUrl = config.dk.restUrl ?? `https://sportsbook-nash.draftkings.com/api/sportscontent/${config.dk.site}/v1/leagues/${config.dk.leagueId}`;
const dkRes = await fetch(dkUrl, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: 'https://sportsbook.draftkings.com', Referer: 'https://sportsbook.draftkings.com/' } });
if (!dkRes.ok) throw new Error(`DraftKings REST ${dkRes.status}; run \`npm run probe\` first`);
const dkText = await dkRes.text();
save('dk-snapshot.json', dkText);
const partials = Object.entries((JSON.parse(dkText).subscriptionPartials ?? {}) as Record<string, { entity?: string; query?: string; includeMarkets?: string }>).filter(([, p]) => p.entity && p.query);

// DraftKings socket frames
const frames: string[] = [];
await new Promise<void>((resolve, reject) => {
  const ws = new WebSocket(config.dk.wsUrl, { headers: { 'User-Agent': BROWSER_UA, Origin: 'https://sportsbook.draftkings.com' } });
  const t = setTimeout(() => (ws.terminate(), resolve()), seconds * 1000);
  ws.on('open', () => {
    for (const [id, p] of partials) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', id, params: { entity: p.entity, queryParams: { query: p.query, ...(p.includeMarkets ? { includeMarkets: p.includeMarkets } : {}), initialData: false, projection: 'sportsbook', locale: 'en-US' }, forwardedHeaders: {}, clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': 'unknown' }, jwt: '', siteName: config.dk.site } }));
    console.log(`listening to the DraftKings socket for ${seconds} s…`);
  });
  ws.on('message', (m) => frames.push(m.toString()));
  ws.on('error', (e) => (clearTimeout(t), reject(e)));
});
save('dk-frames.jsonl', frames.join('\n') + '\n');
console.log(`  ${frames.filter((f) => f.includes('"update"')).length} update frames`);

// FanDuel page + prices
const u = new URL(config.fd.pageUrl);
u.search = new URLSearchParams({ page: 'CUSTOM', customPageId: config.fd.pageId, _ak: config.fd.apiKey, timezone: 'America/New_York' }).toString();
const fdHeaders = { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: config.fd.origin, Referer: `${config.fd.origin}/` };
const fdRes = await fetch(u, { headers: fdHeaders });
if (!fdRes.ok) throw new Error(`FanDuel page ${fdRes.status}`);
const fdText = await fdRes.text();
save('fd-page.json', fdText);
const ids = (Object.values(JSON.parse(fdText).attachments?.markets ?? {}) as Array<{ marketId: string; marketType: string }>)
  .filter((m) => ['MONEY_LINE', 'MATCH_HANDICAP_(2-WAY)', 'TOTAL_POINTS_(OVER/UNDER)'].includes(m.marketType))
  .map((m) => m.marketId);
const prices: unknown[] = [];
for (let i = 0; i < ids.length; i += 70) {
  const r = await fetch(config.fd.pricesUrl, { method: 'POST', headers: { ...fdHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ marketIds: ids.slice(i, i + 70) }) });
  if (!r.ok) throw new Error(`FanDuel prices ${r.status}`);
  prices.push(...((await r.json()) as unknown[]));
}
save('fd-prices.json', JSON.stringify(prices));
console.log(`\nDone. Run \`npm test\` to check the parsers against these captures.`);
