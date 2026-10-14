/**
 * Watch a running board (local or deployed) and print the latency table for the README.
 *   npm run measure -- https://your-app.onrender.com 600     (URL, seconds; default 300)
 * It opens the SSE stream like a browser would, so "→ this machine" includes the server → browser hop.
 */
const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const seconds = Number(process.argv[3] ?? 300);

// Clock offset vs the server, NTP-style (best of 5).
let offset = 0;
let bestRtt = Infinity;
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  const { serverTs } = (await (await fetch(`${base}/api/time`)).json()) as { serverTs: number };
  const t1 = Date.now();
  if (t1 - t0 < bestRtt) (bestRtt = t1 - t0), (offset = serverTs - (t0 + t1) / 2);
}
const now = () => Date.now() + offset;

type Q = { book: string; sourceTs: number; receivedTs: number; american: number; line: number | null };
const samples: Record<string, number[]> = {};
const add = (k: string, v: number) => (samples[k] ??= []).push(v);

const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), seconds * 1000);
const live = new Set<string>();
try {
  const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (!data) continue;
      const d = JSON.parse(data);
      const t = now();
      if (ev === 'snapshot') for (const g of d.games) if (g.live) live.add(g.gameKey);
      if (ev !== 'delta') continue;
      for (const g of d.games) (g.live ? live.add(g.gameKey) : live.delete(g.gameKey));
      for (const c of d.changes as Array<{ q: (Q & { gameKey: string }) | null; prev: unknown }>) {
        if (!c.q || !c.prev) continue;
        const phase = live.has(c.q.gameKey) ? 'live' : 'pregame';
        add(`${c.q.book}|${phase}|server_to_here`, t - d.emitTs);
        if (c.q.book === 'draftkings') add(`${c.q.book}|${phase}|book_to_here`, t - c.q.sourceTs);
      }
    }
  }
} catch (e) {
  if ((e as Error).name !== 'AbortError') throw e;
}

const m = (await (await fetch(`${base}/api/metrics`)).json()) as { latency: Record<string, { n: number; p50: number; p95: number }> };
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
console.log(`\nWatched ${base} for ${seconds} s (clock offset ${Math.round(offset)} ms, RTT ${bestRtt} ms)\n`);
console.log('| Book | Phase | Stage | n | p50 | p95 |\n|---|---|---|---|---|---|');
for (const [k, a] of Object.entries(samples).sort()) {
  const [book, phase, stage] = k.split('|');
  console.log(`| ${book} | ${phase} | ${stage} | ${a.length} | ${pct(a, 0.5)} ms | ${pct(a, 0.95)} ms |`);
}
for (const [k, s] of Object.entries(m.latency).sort()) {
  const [book, phase, stage] = k.split('|');
  console.log(`| ${book} | ${phase} | server: ${stage} | ${s.n} | ${s.p50} ms | ${s.p95} ms |`);
}
