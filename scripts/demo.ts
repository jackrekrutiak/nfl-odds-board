/** Runs the real server against the local mock books (no network needed). `npm run demo` */
import { startMockBooks } from './mock-books.js';

const mock = await startMockBooks(Number(process.env.MOCK_PORT ?? 4100), { autoMove: true });
const base = `http://127.0.0.1:${mock.port}`;
Object.assign(process.env, {
  DK_REST_URL: `${base}/dk/leagues`,
  DK_WS_URL: `ws://127.0.0.1:${mock.port}/dk/ws`,
  FD_PAGE_URL: `${base}/fd/page`,
  FD_PRICES_URL: `${base}/fd/prices`,
  FD_EVENT_URL: `${base}/fd/event`,
  FD_PAGE_MS: '5000',
});
const { buildApp } = await import('../src/server/main.js');
const { config } = await import('../src/config.js');
const app = buildApp();
app.server.listen(config.port, () => {
  console.log(`demo board: http://localhost:${config.port}  (mock books on ${base}; prices move every ~1.5 s)`);
  console.log(`break things: curl -X POST ${base}/control/fd/down   (or dk-ws / dk-rest, then /up)`);
});
