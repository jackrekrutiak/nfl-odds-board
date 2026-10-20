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

console.log(`site ${config.dk.site} · ${base}`);
const league = await get(base);
console.log(`league: HTTP ${league.status}, ${league.text.length} chars`);
if (league.status !== 200) { console.log(league.text.slice(0, 300)); process.exit(1); }
writeFileSync(out('dk-league.json'), league.text);
const items = named(JSON.parse(league.text));
const cats = items.filter((i) => /categor/i.test(i.path));
console.log('\ncategories / subcategories found:');
for (const c of cats) console.log(`  ${c.path.padEnd(16)} id=${c.id.padEnd(8)} ${c.name}${c.categoryId ? ` (category ${c.categoryId})` : ''}`);

const td = cats.filter((c) => /td|touchdown/i.test(c.name));
const catIds = [...new Set(cats.filter((c) => /^categories$/i.test(c.path)).map((c) => c.id))];
const tries: string[] = [];
for (const s of td) {
  if (s.categoryId) tries.push(`${base}/categories/${s.categoryId}/subcategories/${s.id}`);
  for (const c of catIds) tries.push(`${base}/categories/${c}/subcategories/${s.id}`);
  tries.push(`${base}/categories/${s.id}`);
}
console.log(`\ntrying ${tries.length} TD-scorer URLs…`);
for (const url of [...new Set(tries)].slice(0, 12)) {
  const r = await get(url);
  const ok = r.status === 200 && /selections/.test(r.text);
  console.log(`  HTTP ${r.status} ${ok ? '✓' : ' '} ${url.replace(base, '')}`);
  if (ok) {
    writeFileSync(out('dk-td-scorers.json'), r.text);
    console.log(`\nSaved ${r.text.length} chars to ~/Desktop/dk-td-scorers.json. Attach that file.`);
    process.exit(0);
  }
}
console.log('\nNo TD-scorer response yet. Send a screenshot of this output, and attach ~/Desktop/dk-league.json.');
