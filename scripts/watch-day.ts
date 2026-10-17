/**
 * Watch a deployed board for hours (e.g. a full NFL Sunday) and write the latency distribution,
 * hour by hour, per book and phase (pregame vs live), with p50 / p95 / p99 / max.
 *
 *   npm run watch-day -- https://nfl-odds-board.onrender.com 5.75 latency/2026-10-18-a.md
 *   (URL, hours, output file; BUCKET_MIN=60 sets the bucket size)
 *
 * Stages, all in milliseconds:
 *   book_to_server  DraftKings engine stamp → our server (from each quote's sourceTs/receivedTs;
 *                   the server has already corrected for clock skew)
 *   server_to_here  our server → this machine (each frame's emitTs, with an NTP-style offset)
 *   book_to_here    DraftKings engine stamp → this machine, end to end
 * Every bucket also snapshots the server's own /api/metrics (incl. the network-only leg).
 * Reconnects if the stream drops, so it survives a long run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const hours = Number(process.argv[3] ?? 1);
const outFile = process.argv[4] ?? `latency/${new Date().toISOString().slice(0, 10)}.md`;
const bucketMin = Number(process.env.BUCKET_MIN ?? 60);
const deadline = Date.now() + hours * 3600_000;

const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const bucketOf = (ms: number) => {
  const start = Math.floor(ms / (bucketMin * 60_000)) * bucketMin * 60_000;
  return { key: String(start), label: `${et.format(start)} ET` };
};

async function clockOffset(): Promise<{ offset: number; rtt: number }> {
  let offset = 0;
  let rtt = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const { serverTs } = (await (await fetch(`${base}/api/time`, { signal: AbortSignal.timeout(15_000) })).json()) as { serverTs: number };
    const t1 = Date.now();
    if (t1 - t0 < rtt) (rtt = t1 - t0), (offset = serverTs - (t0 + t1) / 2);
  }
  return { offset, rtt };
}

type Quote = { book: string; gameKey: string; sourceTs: number; receivedTs: number };
const samples = new Map<string, number[]>(); // `${bucket}|${book}|${phase}|${stage}`
const labels = new Map<string, string>(); // bucket → label
const liveGames = new Map<string, Set<string>>(); // bucket → live game keys seen
const serverSnaps: Array<{ label: string; latency: Record<string, { n: number; p50: number; p95: number; max: number }> }> = [];
let reconnects = 0;
let lastSnapBucket = '';

const add = (bucket: string, k: string, v: number) => {
  if (!Number.isFinite(v)) return;
  const key = `${bucket}|${k}`;
  let a = samples.get(key);
  if (!a) samples.set(key, (a = []));
  a.push(v);
};

async function snapshotServer(label: string) {
  try {
    const m = (await (await fetch(`${base}/api/metrics`, { signal: AbortSignal.timeout(15_000) })).json()) as { latency: (typeof serverSnaps)[number]['latency'] };
    serverSnaps.push({ label, latency: m.latency });
  } catch (e) {
    console.error('metrics snapshot failed', String(e));
  }
}

async function watchOnce() {
  const { offset, rtt } = await clockOffset();
  console.log(`connected: clock offset ${Math.round(offset)} ms, RTT ${rtt} ms`);
  const now = () => Date.now() + offset;
  const live = new Set<string>();
  const ctrl = new AbortController();
  const stop = setTimeout(() => ctrl.abort(), Math.max(0, deadline - Date.now()));
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
        const b = bucketOf(t);
        labels.set(b.key, b.label);
        if (b.key !== lastSnapBucket) {
          if (lastSnapBucket) void snapshotServer(labels.get(lastSnapBucket)!);
          lastSnapBucket = b.key;
        }
        if (ev === 'snapshot') for (const g of d.games) if (g.live) live.add(g.gameKey);
        if (ev !== 'delta') continue;
        for (const g of d.games) (g.live ? live.add(g.gameKey) : live.delete(g.gameKey));
        for (const c of d.changes as Array<{ q: Quote | null; prev: unknown }>) {
          if (!c.q || !c.prev) continue; // only real moves, not first sightings
          const phase = live.has(c.q.gameKey) ? 'live' : 'pregame';
          if (phase === 'live') {
            let s = liveGames.get(b.key);
            if (!s) liveGames.set(b.key, (s = new Set()));
            s.add(c.q.gameKey);
          }
          add(b.key, `${c.q.book}|${phase}|server_to_here`, t - d.emitTs);
          if (c.q.book === 'draftkings') {
            add(b.key, `draftkings|${phase}|book_to_server`, c.q.receivedTs - c.q.sourceTs);
            add(b.key, `draftkings|${phase}|book_to_here`, t - c.q.sourceTs);
          }
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  } finally {
    clearTimeout(stop);
  }
}

while (Date.now() < deadline) {
  try {
    await watchOnce();
  } catch (e) {
    reconnects++;
    console.error('stream error, reconnecting in 5 s:', String(e));
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
await snapshotServer(`end (${et.format(Date.now())} ET)`);

// ---------- report ----------
const pct = (s: number[], p: number) => Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!);
const row = (label: string, k: string, a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const [book, phase, stage] = k.split('|');
  return `| ${label} | ${book} | ${phase} | ${stage} | ${s.length} | ${pct(s, 0.5)} | ${pct(s, 0.95)} | ${pct(s, 0.99)} | ${Math.round(s[s.length - 1]!)} |`;
};
const head = '| When | Book | Phase | Stage | n | p50 ms | p95 ms | p99 ms | max ms |\n|---|---|---|---|---|---|---|---|---|';

const overall = new Map<string, number[]>();
for (const [key, a] of samples) {
  const k = key.split('|').slice(1).join('|');
  overall.set(k, [...(overall.get(k) ?? []), ...a]);
}

const lines: string[] = [];
lines.push(`# Latency, ${new Date().toISOString().slice(0, 10)}: ${base}`);
lines.push('');
lines.push(`Watched for ${hours} h in ${bucketMin}-minute buckets, from a GitHub Actions runner (US). Stream reconnects: ${reconnects}. Only real price moves are counted (not first sightings).`);
lines.push('');
lines.push('## Whole run');
lines.push('');
lines.push(head);
for (const [k, a] of [...overall].sort(([x], [y]) => x.localeCompare(y))) lines.push(row('all', k, a));
lines.push('');
lines.push('## By hour');
lines.push('');
lines.push(head);
for (const key of [...samples.keys()].sort()) {
  const [bucket, ...rest] = key.split('|');
  lines.push(row(labels.get(bucket!) ?? bucket!, rest.join('|'), samples.get(key)!));
}
lines.push('');
lines.push('## Live games seen per hour');
lines.push('');
lines.push('| When | Live games with moves |\n|---|---|');
for (const [bucket, label] of [...labels].sort()) lines.push(`| ${label} | ${liveGames.get(bucket)?.size ?? 0} |`);
lines.push('');
lines.push("## Server's own metrics at each hour (its last up-to-500 samples per stage)");
lines.push('');
lines.push('| When | Key | n | p50 ms | p95 ms | max ms |\n|---|---|---|---|---|---|');
for (const snap of serverSnaps) {
  for (const [k, s] of Object.entries(snap.latency).sort()) {
    if (!k.startsWith('draftkings')) continue;
    lines.push(`| ${snap.label} | ${k.split("|").join(" · ")} | ${s.n} | ${s.p50} | ${s.p95} | ${s.max} |`);
  }
}
const report = lines.join('\n') + '\n';
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, report);
console.log(report);
console.log(`written to ${outFile}`);
