import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { LatencyTracker } from '../core/latency.js';
import { OddsStore } from '../core/store.js';
import type { BookHealth } from '../core/types.js';
import type { AdapterSink, BookAdapter } from '../books/adapter.js';
import { DraftKingsAdapter } from '../books/draftkings/adapter.js';
import { FanDuelAdapter } from '../books/fanduel/adapter.js';
import { SseHub } from './hub.js';

const log = (msg: string, extra?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

export function buildApp() {
  const store = new OddsStore();
  const latency = new LatencyTracker();
  const adapters: BookAdapter[] = [];
  if (config.dk.enabled) adapters.push(new DraftKingsAdapter(config.dk, config.staleAfterMs));
  if (config.fd.enabled) adapters.push(new FanDuelAdapter(config.fd, config.staleAfterMs));

  const health = (): BookHealth[] => adapters.map((a) => a.health());
  const metrics = () => ({
    latency: latency.summary(),
    sse: { clients: hub.clientCount, frames: hub.sentFrames, bytes: hub.sentBytes },
    books: Object.fromEntries(adapters.map((a) => [a.book, a.stats()])),
  });
  const hub = new SseHub(store, health, metrics, config.heartbeatMs);

  for (const a of adapters) {
    const sink: AdapterSink = {
      snapshot: (s) => store.applySnapshot(s).changes.length,
      delta: (d) => store.applyDelta(d).changes.length,
      latency: (phase, metric, ms) => latency.record(a.book, phase, metric, ms),
      log: (msg, extra) => log(msg, { book: a.book, ...extra }),
    };
    a.start(sink);
  }

  const publicDir = fileURLToPath(new URL('../../public/', import.meta.url).href.replace('/dist/', '/'));
  let lastRefresh = 0;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === '/api/stream') return hub.connect(res, (req.headers['last-event-id'] as string | undefined) ?? url.searchParams.get('lastEventId') ?? undefined);
      if (url.pathname === '/api/board') return json(res, hub.snapshotPayload());
      if (url.pathname === '/api/time') return json(res, { serverTs: Date.now() });
      if (url.pathname === '/api/metrics') return json(res, { serverTs: Date.now(), region: config.region, health: health(), ...metrics() });
      if (url.pathname === '/healthz') return json(res, { ok: true, health: health() });
      if (url.pathname === '/api/refresh' && req.method === 'POST') {
        if (Date.now() - lastRefresh < 5_000) return json(res, { ok: false, error: 'rate limited' }, 429);
        lastRefresh = Date.now();
        const results = await Promise.allSettled(adapters.map((a) => a.refresh()));
        return json(res, { ok: true, results: results.map((r, i) => ({ book: adapters[i]!.book, ok: r.status === 'fulfilled' })) });
      }
      return serveStatic(publicDir, url.pathname, res);
    } catch (err) {
      log('request failed', { path: url.pathname, error: String(err) });
      if (!res.headersSent) json(res, { error: 'internal error' }, 500);
    }
  });

  const close = () => {
    for (const a of adapters) a.stop();
    hub.close();
    server.close();
  };
  return { server, store, hub, adapters, close };
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function serveStatic(dir: string, path: string, res: ServerResponse): Promise<void> {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(dir, rel);
  if (!file.startsWith(dir)) return json(res, { error: 'not found' }, 404);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    json(res, { error: 'not found' }, 404);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).replace(/\.ts$/, '').replace(/\.js$/, '') === process.argv[1].replace(/\.(ts|js)$/, '');
if (isMain) {
  const app = buildApp();
  app.server.listen(config.port, () => log('listening', { port: config.port, region: config.region }));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (app.close(), process.exit(0)));
}
