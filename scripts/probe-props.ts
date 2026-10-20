/**
 * Find DraftKings' TD-scorer props and save one real response, so the parser is built on real data.
 *   npx tsx scripts/probe-props.ts        → writes dk-td-scorers.json (and dk-league.json) to your Desktop
 */
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_UA, config } from '../src/config.js';

const base = `https://sportsbook-nash.draftkings.com/api/sportscontent/${config.dk.site}/v1/leagues/${config.dk.leagueId}`;
const headers = { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: 'https://sportsbook.draftkings.com', Referer: 'https://sportsbook.draftkings.com/' };
const out = (name: string) => join(homedir(), 'Desktop', name);

async function get(url: string): Promise<{ status: number; text: string }> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  return { status: r.status, text: await r.text() };
}

// (kept for exploring other sections)
// Every { id, name } object anywhere in the response, with the array it sits in.
function named(x: unknown, path = '', acc: Array<{ path: string; id: string; name: string; categoryId?: string }> = []) {
  if (Array.isArray(x)) x.forEach((v) => named(v, path, acc));
  else if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if ((typeof o.id === 'string' || typeof o.id === 'number') && typeof o.name === 'string')
      acc.push({ path, id: String(o.id), name: o.name, ...(o.categoryId !== undefined ? { categoryId: String(o.categoryId) } : {}) });
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object') named(v, k, acc);
  }
  return acc;
}

console.log(`site ${config.dk.site}`);
// Over/under player props: list each section's subcategories and print one sample market from each.
const league = JSON.parse((await get(base)).text);
writeFileSync(out('dk-league.json'), JSON.stringify(league));
const CATS: Record<string, string> = { '1000': 'Passing', '1001': 'Rushing', '1342': 'Receiving', '1003': 'TD Scorers' };
const subs = (league.subcategories ?? []).filter((x: { categoryId: number }) => CATS[String(x.categoryId)]);
const report: unknown[] = [];
for (const sub of subs.slice(0, 16)) {
  const r = await get(`${base}/categories/${sub.categoryId}/subcategories/${sub.id}`);
  const j = r.status === 200 ? JSON.parse(r.text) : {};
  const markets: Array<Record<string, unknown>> = j.markets ?? [];
  const m = markets[0];
  const sels = m ? (j.selections ?? []).filter((x: { marketId: string }) => x.marketId === m.id).slice(0, 2) : [];
  const types = [...new Set(markets.map((x) => JSON.stringify(x.marketType)))].slice(0, 6);
  console.log(`  ${CATS[String(sub.categoryId)]} / ${sub.name} (${sub.id}): HTTP ${r.status}, ${markets.length} markets`);
  report.push({ cat: sub.categoryId, sub: sub.id, subName: sub.name, markets: markets.length, types, sampleMarket: m && { id: m.id, eventId: m.eventId, name: m.name, marketType: m.marketType }, sampleSelections: sels.map((x: Record<string, unknown>) => ({ label: x.label, outcomeType: x.outcomeType, points: x.points, displayOdds: x.displayOdds, trueOdds: x.trueOdds, participants: x.participants })) });
}
console.log('\n----- copy everything below this line -----');
console.log(JSON.stringify(report));
