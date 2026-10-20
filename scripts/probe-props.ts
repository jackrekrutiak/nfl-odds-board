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
// DraftKings' own ids (from its league response): category 1003 "TD Scorers", subcategory 12438 "TD Scorer".
const url = `${base}/categories/1003/subcategories/12438`;
const r = await get(url);
const j = r.status === 200 ? JSON.parse(r.text) : {};
const n = (k: string) => (Array.isArray(j[k]) ? j[k].length : 0);
console.log(`HTTP ${r.status}: ${n('events')} events, ${n('markets')} markets, ${n('selections')} selections`);
if (!n('selections')) { console.log(r.text.slice(0, 400)); process.exit(1); }
writeFileSync(out('dk-td-scorers.json'), r.text);
// A small sample with every field, enough to write the parser from.
const sample = { event: j.events[0], markets: j.markets.slice(0, 2), selections: j.selections.slice(0, 3) };
console.log('\n----- copy everything below this line -----');
console.log(JSON.stringify(sample));
