/**
 * Everything configurable lives here. Both books are region-locked; pick the preset that
 * matches where the server runs (`npm run probe` tells you which one works from a host).
 *
 *   REGION=us  DraftKings New Jersey + FanDuel New Jersey (.com)  — US hosts (Render Ohio, Fly iad/ewr)
 *   REGION=ca  DraftKings Ontario + FanDuel Ontario (.ca)          — Canadian IPs (local in Canada, Fly yyz)
 */
const env = process.env;
const region = (env.REGION ?? 'us').toLowerCase() === 'ca' ? 'ca' : 'us';

const presets = {
  us: { dkSite: 'dkusnj', dkWsRegion: 'us-nj', fdState: 'nj', fdTld: 'com', fdOrigin: 'https://sportsbook.fanduel.com' },
  ca: { dkSite: 'dkcaon', dkWsRegion: 'ca-on', fdState: 'on', fdTld: 'ca', fdOrigin: 'https://sportsbook.fanduel.ca' },
} as const;
const p = presets[region];

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : !/^(0|false|no|off)$/i.test(v));

export const config = {
  port: num(env.PORT, 3000),
  region,

  dk: {
    enabled: bool(env.DK_ENABLED, true),
    leagueId: env.DK_LEAGUE_ID ?? '88808', // NFL
    site: env.DK_SITE ?? p.dkSite,
    restUrl: env.DK_REST_URL, // override (mock books / tests)
    wsUrl: env.DK_WS_URL ?? `wss://sportsbook-ws-${env.DK_WS_REGION ?? p.dkWsRegion}.draftkings.com/websocket?format=json&locale=en-US`,
    resyncMs: num(env.DK_RESYNC_MS, 60_000), // integrity check while the socket is live
    pollMs: num(env.DK_POLL_MS, 3_000), // fallback cadence while the socket is down
    wsFallbackAfterMs: num(env.DK_WS_FALLBACK_AFTER_MS, 10_000),
    // Player props (TD Scorers section) read from REST every DK_PROPS_MS; next step is subscribing them on the socket.
    propsEnabled: bool(env.DK_PROPS_ENABLED, true),
    propsMs: num(env.DK_PROPS_MS, 10_000),
  },

  fd: {
    enabled: bool(env.FD_ENABLED, true),
    pageId: env.FD_PAGE_ID ?? 'nfl',
    apiKey: env.FD_API_KEY ?? 'FhMFpcPWXMeyZxOx', // the public key FanDuel's own web bundle sends
    pageUrl: env.FD_PAGE_URL ?? `https://sbapi.${env.FD_STATE ?? p.fdState}.sportsbook.fanduel.${p.fdTld}/api/content-managed-page`,
    pricesUrl: env.FD_PRICES_URL ?? `https://smp.${env.FD_STATE ?? p.fdState}.sportsbook.fanduel.${p.fdTld}/api/sports/fixedodds/readonly/v1/getMarketPrices`,
    origin: env.FD_ORIGIN ?? p.fdOrigin,
    pricesMs: num(env.FD_PRICES_MS, 2_000), // uncached price channel, pregame markets
    livePricesMs: num(env.FD_LIVE_PRICES_MS, 1_000), // in-game markets move far more often: poll them faster
    pageMs: num(env.FD_PAGE_MS, 30_000), // structure: matches the page's CDN max-age
    pricesEnabled: bool(env.FD_PRICES_ENABLED, true),
    // Player props: each game's event page (structure) every FD_PROPS_MS; their prices ride the price channel.
    propsEnabled: bool(env.FD_PROPS_ENABLED, true),
    propsMs: num(env.FD_PROPS_MS, 60_000),
    // Pregame prop prices: hundreds of markets, and they move less than sides/totals. Live props use the live cadence.
    propPricesMs: num(env.FD_PROP_PRICES_MS, 10_000),
    eventUrl: env.FD_EVENT_URL,
  },

  // Render's free tier sleeps after 15 min with no inbound traffic, which would drop the DK socket.
  // The server requests its own public URL to count as traffic. Render sets RENDER_EXTERNAL_URL;
  // locally nothing is set, so nothing runs. SELF_PING_MS=0 turns it off.
  selfPingUrl: env.SELF_PING_URL ?? env.RENDER_EXTERNAL_URL,
  selfPingMs: num(env.SELF_PING_MS, 10 * 60_000),

  staleAfterMs: num(env.STALE_AFTER_MS, 30_000),
  heartbeatMs: num(env.HEARTBEAT_MS, 2_000),
};

export type Config = typeof config;

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
