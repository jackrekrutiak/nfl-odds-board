# NFL Odds Board — DraftKings vs FanDuel, live

Pregame and in-game NFL moneyline, spread and total from **DraftKings** and **FanDuel**, normalized into one model and shown side by side. A toggle switches between **Best Price** (with the book underneath), **DraftKings** and **FanDuel**. Prices update on their own as lines move, and each book's freshness is on the page.

- **Live:** https://nfl-odds-board.onrender.com (Render free tier, Ohio; the first request after idle can take ~50 s to wake)
- **Stack:** Node 22 + TypeScript, one runtime dependency (`ws`). No framework, no headless browser, no third-party odds API.

![Board](docs/desktop.png)

## TL;DR

| Question | Answer |
|---|---|
| How is each book read? | **DraftKings:** its own push WebSocket (JSON-RPC subscribe → deltas, each stamped with DK's `createdTime`), bootstrapped and re-checked by its REST snapshot. **FanDuel:** no public push feed for sportsbook prices, so the uncached `getMarketPrices` endpoint its betslip polls, every 2 s, on top of the CDN-cached coupon page for structure. |
| How old is the number on screen? | **DraftKings:** measured from DK's own timestamps, see [Latency](#latency). **FanDuel:** FD publishes no timestamps, so it's a bound: ≤ poll interval + one round trip (≈ 2.1 s), shown on the page. |
| Browser push | Server-Sent Events. One frame per upstream change, serialized once for all viewers, sent immediately. |
| One book down? | Each book has its own state machine. The other keeps updating; the broken book's cells grey out with a banner saying how old they are. |
| Third book? | Implement `BookAdapter` (4 methods) and register it. Store, best price, SSE and UI are book-agnostic. |

## Run it

Requires Node 22+.

```bash
npm install
npm run demo      # the real server + adapters against local mock books — no network needed
npm run dev       # against the real books (REGION=us default; REGION=ca for Ontario)
npm test          # 30 tests, ~3 s, incl. end-to-end against the mock books (+3 on real captures, below)
npm run probe     # "can this machine reach DK and FD?" — run on your laptop and on the host
npm run capture   # record real payloads from both books into fixtures/ (then npm test checks them)
npm run audit     # 15 min: does the DK push feed miss anything vs REST?
npm run measure -- https://<your-app> 600   # watch a running board, print the latency table
```

Open http://localhost:3000.

**Pick the region preset to match where the server runs** (both books are geo-locked):

| `REGION` | DraftKings | FanDuel | Use from |
|---|---|---|---|
| `us` (default) | `dkusnj`, `sportsbook-ws-us-nj` | `sbapi.nj.sportsbook.fanduel.com` | US hosts (Render Ohio, Fly iad) |
| `ca` | `dkcaon`, `sportsbook-ws-ca-on` | `sbapi.on.sportsbook.fanduel.ca` | Canadian IPs (local in Canada, Fly yyz) |

Every URL can be overridden individually (`DK_REST_URL`, `DK_WS_URL`, `FD_PAGE_URL`, `FD_PRICES_URL`, …) — see `src/config.ts`.

## Architecture

```
  DraftKings                                   one Node process                                 browsers
  ──────────                                   ────────────────                                 ────────
  REST snapshot ──(boot, 60 s re-check,──►  DraftKingsAdapter ─┐
  sportsbook-nash…/leagues/88808   3 s poll   DkBoard: raw events/markets/selections,  │
                   if socket down)            applies {add,change,remove} deltas        │
  Push socket ────(deltas, ~1/s)────────►     → clean quotes for touched games only     │
  sportsbook-ws-…/websocket                                                             ▼
                                                                         OddsStore (diffs everything)  ──► SseHub ── SSE ──► board
  FanDuel                                                                 + best price per slot           one frame per change,
  ───────                                                                               ▲                  serialized once,
  Coupon page ──(structure, 30 s, ETag)──►  FanDuelAdapter ────────────────────────────┘                  replay on reconnect
  sbapi…/content-managed-page               FdBoard: page = which games/markets exist,
  getMarketPrices ──(prices, every 2 s)─►     price channel overlaid on top
  smp…/getMarketPrices (uncached)
```

- **One ingestion per book**, not per tab. 1 or 1,000 viewers cost the books the same: one DK socket, one FD poller.
- **Everything becomes a delta.** DK sends deltas; FD sends full pictures. Both go through `OddsStore`, which diffs, so the browser only ever receives changes (with the previous price, for the flash and "was" display).
- **Best price is computed once, server-side**, for only the slots that changed, and shipped with the delta.
- **Clean model** (`src/core/types.ts`): `game → market (moneyline | spread | total) → side (away/home, over/under) → line + odds + book`. Games match across books by a canonical key `nfl:<ET date>:<AWAY>@<HOME>` from a 32-team registry (`src/core/teams.ts`); unknown names are never guessed.

```
src/core/       book-agnostic: types, team registry, odds, best price, store, latency
src/books/      one folder per book: adapter (transport) + normalize (shape → model)
src/server/     HTTP routes, SSE hub
public/         the board (plain HTML/CSS/JS, no build step)
scripts/        demo, mock books, probe, measure
test/           unit tests + end-to-end against mock books
```

## Getting the data

Found by watching the Network tab on each site's NFL page (on load, and while sitting on a live game) and reading their client JavaScript.

### DraftKings: push

- **Snapshot:** `GET https://sportsbook-nash.draftkings.com/api/sportscontent/{site}/v1/leagues/88808`. Returns flat `events[]`, `markets[]`, `selections[]` referencing each other by id, plus `subscriptionPartials` — the exact socket queries DK's own client subscribes with. We subscribe with those rather than hard-coding a query.
- **Socket:** `wss://sportsbook-ws-{region}.draftkings.com/websocket?format=json`, JSON-RPC `subscribe` → `subscribed` ack (carries DK's server time) → `update` frames: `{add, change, remove} × {events, markets, selections}` with `metadata.createdTime` and `websocketPublishTimestamp`. DK's site uses `format=msgpack`; `format=json` carries the same messages.
- **Why:** it is exactly what DK's site does — changes only, the moment they're published, one connection, no login. Polling REST can't beat it (and the REST response is CDN-cached anyway).
- **REST's other jobs:** bootstrap; a 60 s integrity re-check while the socket is up (any price that differs from what the deltas produced is counted as a `resyncCorrection` in `/api/metrics` — it should stay 0); and the fallback, polled every 3 s, when the socket has been down for 10 s.

### FanDuel: two polled channels

- **Structure:** `GET https://sbapi.{state}.sportsbook.fanduel.{tld}/api/content-managed-page?page=CUSTOM&customPageId=nfl&_ak=…` (`_ak` is a public constant in FanDuel's web bundle). Which games and markets exist. It sits behind CloudFront (`max-age=30`), so it can be up to 30 s old no matter how fast you poll it. Read every 30 s with `If-None-Match`; an unchanged page is a body-less 304.
- **Prices:** `POST https://smp.{state}.sportsbook.fanduel.{tld}/api/sports/fixedodds/readonly/v1/getMarketPrices` with `{"marketIds": [...]}` — the endpoint FanDuel's betslip polls. `Cache-Control: no-cache`, ~1 KB per market, no key or cookie. Batched at 70 ids (larger batches are truncated silently).
- **Why polling, and why 2 s:** there is no public socket for FanDuel sportsbook prices (the AppSync socket in their bundle belongs to their prediction-market product). With polling, freshness = interval + RTT. FanDuel's own client polls this every 5 s; 2 s gets the bound to ~2.1 s at ~1 small request/s (NFL is ~96 game-line markets → 2 batches). Going to 1 s would halve the bound again for twice the requests to a book that gives us no rate-limit headroom signal; 2 s felt like the right side of that trade. It's one env var (`FD_PRICES_MS`).
- If the price channel fails, the adapter falls back to the page's own prices, says so on the page, and the stated bound widens to the page's ~60 s.

## Shape of the data & matching

| | DraftKings | FanDuel |
|---|---|---|
| Delivery | Socket: **deltas only** — you keep the rest. REST: full picture. | **Full picture** every poll. |
| Teams | `participants[].venueRole` + `"DET Lions"` | `"Detroit Lions @ Buffalo Bills"` |
| Market | `marketType.name` Moneyline / Spread / Total | `MONEY_LINE`, `MATCH_HANDICAP_(2-WAY)`, `TOTAL_POINTS_(OVER/UNDER)` (+ futures to ignore) |
| Side | `outcomeType` Home/Away/Over/Under | `result.type` HOME/AWAY/OVER/UNDER |
| Line | `points` | `handicap` (0 on moneylines) |
| Odds | `trueOdds` (decimal) + `displayOdds.american` with a **Unicode minus** (`−110`) | `americanDisplayOdds.americanOdds` + `trueOdds.decimalOdds.decimalOdds` |
| Kickoff | 7 fractional-second digits | often listed a minute later than DK |

DraftKings delta gotchas, all covered by tests (`test/books.test.ts`):
- `change` objects are **partial** (a price change has no `marketId`), so they're merged onto what we hold.
- A **line move gets a new selection id** with `replacedSelectionId` and no `marketId`; we carry the old selection's fields over. Updating "by id" would silently lose every line move. Moves can also arrive as remove + add.
- A change that references something we don't know triggers a REST re-check (rate-limited) instead of a guess.
- Malformed records are dropped and counted (`invalidEntities`), never fatal.

### "Best price" across different lines

**The call: the line first, the price breaks ties.** For a side, `-3 -110` beats `-3.5 +100`; for totals, Over wants the lower number and Under the higher one. Line shoppers shop the number first, and in the NFL a half point — especially onto or off **3 and 7** — is worth more than 10 cents of juice.

One exception, so it doesn't do anything silly: between non-key numbers, if the worse line pays ≥ 20 cents more per half point (e.g. `-5.5 -105` vs `-6 +120`), the price wins. Suspended prices never win. Hovering a cell shows the other book's line and price, and the per-book views show everything (`src/core/best.ts`, `test/core.test.ts`).

## Latency

**How it's measured.** DraftKings stamps every delta with `createdTime` (its odds engine) and `websocketPublishTimestamp` (its socket layer). The server stamps receipt. Clock skew to DK is estimated NTP-style from the subscribe round trip, then tightened from traffic (a frame can't arrive before it was published, so negative wire times nudge the estimate). The browser estimates its offset to the server via `/api/time` and measures server → screen with each frame's `emitTs`.

FanDuel publishes no timestamps, so there's nothing to measure against: the honest number is a **bound**, interval + round trip, and the page says "age ≤ 2.1 s" rather than pretending.

**Measured** (`npm run measure -- <url> 600` against the deployed app; also live at `/api/metrics`):

<!-- TODO: paste the table `npm run measure` prints, ideally once during a live game (TNF Thu / Sunday) and once pregame. -->

| Book | Phase | Stage | p50 | p95 |
|---|---|---|---|---|
| DraftKings | pregame | DK engine → our server | _TBD_ | _TBD_ |
| DraftKings | live | DK engine → our server | _TBD_ | _TBD_ |
| DraftKings | both | DK socket publish → our server (network) | _TBD_ | _TBD_ |
| DraftKings | both | our server → browser | _TBD_ | _TBD_ |
| FanDuel | both | bound: poll interval + price RTT | ≈ 2.1 s | |

**What was done to bring it down:**
- **Push, not poll, for DK** — the biggest lever by far. Per-update work is proportional to what changed: a delta re-normalizes only the touched game, never the board.
- **The uncached price endpoint for FD** instead of the 30 s CDN-cached page: ~30 s → ~2 s.
- **No batching window** on the way to the browser; each SSE frame is serialized once for all clients; `TCP_NODELAY` on; `X-Accel-Buffering: no` so proxies don't hold frames.
- **Small payloads:** deltas carry only changed quotes (a typical DK move is a few hundred bytes); the snapshot is sent once per connection.
- **Reconnects don't reload:** frames carry ids; a reconnecting browser sends `Last-Event-ID` and gets only what it missed from a 1,000-frame ring buffer.
- **Hosting near the books:** US-East (Render Ohio / Fly iad), where both books' US edges are. Where the browser is matters much less — it's one hop of ~20–80 ms.
- **What can't be reduced from outside:** time spent inside DraftKings between its engine stamping a price and its socket publishing it. That shows up as the gap between "engine → server" and "network" in the table.

## What we hit

<!-- TODO: confirm each of these with `npm run probe` from your machine and from the host, and edit to match what you actually saw. -->

- **DraftKings — bot protection (Akamai).** The REST host fingerprints the TLS client: `curl` and Python's default HTTP stack get `403 Access Denied` even with browser headers, while Node's built-in `fetch` is accepted. That's one reason this is Node. Requests send the headers a browser tab would (`Origin`, `Referer`, UA). Cloud IPs can also be refused on the REST host while the socket host accepts them. That's DraftKings' call to make, so the app doesn't try to get around it: the adapter shows **DEGRADED** with the 403 rather than failing silently, `npm run probe` on the host shows it before you deploy, and the fix is a host DraftKings serves normally.
- **DraftKings — geo.** Each region is a separate site (`dkusnj`, `dkcaon`, …); a Canadian IP is served the Ontario product. Configurable via `REGION`.
- **DraftKings — auth.** None: the socket accepts an empty `jwt`, REST needs no cookie, so nothing expires. If DK starts requiring a token, the subscribe isn't acked within 10 s → the socket is abandoned, the adapter falls back to REST polling, and the page says so; close code `4000` (DK's "bad params") backs off 30 s instead of hammering.
- **FanDuel — geo.** The US host refuses Canadian IPs; Canada uses the `.ca` Ontario host. `REGION=ca`.
- **FanDuel — caching.** The page's 30 s CloudFront cache is the real limit, not a rate limit — hence the price channel.
- **FanDuel — re-keyed selections.** A line move can produce a selection id only the page knows yet; an unknown id from the price channel forces an early page read.
- **Rate limits.** None hit at these cadences. 429s back off; failures back off exponentially with jitter.

## Proving it on real data

Mock books prove the plumbing; these prove the parsers and the delta engine against what the books actually send.

- **`npm run capture`** records a DraftKings snapshot, every socket frame for 60 s (`CAPTURE_SECONDS=300` for more), the FanDuel page and its prices into `fixtures/`. `test/real-fixtures.test.ts` then checks that every game maps with nothing invalid, that **replaying every captured delta ends on exactly the board a fresh read of the same state gives**, and that every FanDuel game finds its DraftKings twin by game key.
- **`npm run audit`** builds a DraftKings board from the socket alone, never re-synced, and compares it with a REST read every 5 s for 15 minutes. A price still different on the next comparison is a miss.

<!-- TODO: paste the audit result line, e.g. "20 min, 31 price changes, 0 missed". -->

The skew estimate checks itself too: `/api/metrics → books.draftkings.clockCheck` counts network samples that came out negative (a frame "arriving before it was sent"). That should sit at ~0 after the first few frames; if it climbs, the latency numbers aren't trustworthy.

## Failure handling

| What breaks | What happens | What you see |
|---|---|---|
| DK socket drops | Reconnect with backoff (0.5 → 15 s), REST poll every 3 s after 10 s down, gap-filling re-check on reconnect | DK chip: POLLING |
| DK socket silent | Ping every 15 s; reconnect after 45 s of silence | — |
| DK REST 403 / 5xx | Last good board kept; socket keeps running | Error on hover; DEGRADED if the socket is also down |
| FD price channel fails | Fall back to page prices; bound widens | FD chip: POLLING, "page only" |
| FD fully down | Last good board kept; backoff | FD chip: STALE/DEGRADED, FD cells greyed + banner. **DK unaffected** |
| No contact with a book for 30 s | Marked stale | Banner: "FanDuel is stale — last confirmed 42 s ago"; its cells greyed with STALE; it can't silently win "best" |
| Browser loses the server | `EventSource` reconnects in 1 s with `Last-Event-ID` | "Reconnecting — numbers below are frozen" |
| Unexpected payload | Bad records dropped and counted | `invalidEntities` in `/api/metrics` |

`test/e2e.test.ts` runs the real server against mock books and checks the important ones: both books boot into one board with matching game keys; a DK move reaches an SSE client; a DK line move (re-keyed selection) is followed; an FD move arrives via the price channel; **with DK fully down, FD keeps updating and DK reports stale**; DK recovers.

## HTTP API

| Route | |
|---|---|
| `GET /api/stream` | SSE: `snapshot` on connect, then `delta` (changed quotes + prev + best), `status` every 2 s (health + metrics). Supports `Last-Event-ID`. |
| `GET /api/board` | The whole normalized board as JSON |
| `GET /api/metrics` | Per-book health, counters, latency percentiles, SSE clients |
| `GET /api/time` | Server clock, for the browser's offset |
| `POST /api/refresh` | Force a full re-read of both books (rate-limited) |
| `GET /healthz` | Health check |

## Deploying

Free tiers are enough; it must be an **always-on process** (it holds the DK socket), so not Vercel/Netlify functions.

- **Render (free):** New → Blueprint → this repo. `render.yaml` sets Docker, Ohio, `/healthz`. Free instances sleep after 15 idle minutes; set the repo variable `APP_URL` and `.github/workflows/keepalive.yml` pings it every 10 min.
- **Fly.io:** `fly launch --copy-config --no-deploy && fly deploy` (`fly.toml`: iad, 1 always-on machine).
- **Run `npm run probe` on the host first** (Render shell / `fly ssh console`). After deploying, open `/api/metrics`: both books should be `live`. If DK shows a 403, that host's IPs are refused on the REST host — pick another host or region rather than working around it.

## Scaling: a third book, or ten

- **A third book** = a folder in `src/books/` implementing `BookAdapter` (`start`, `stop`, `health`, `refresh`, `stats`) and emitting snapshots or deltas in the clean model, plus its team spellings in `teams.ts` if they're unusual. Nothing else changes: the store, best price, SSE and UI are keyed by book.
- **Ten books / many leagues:** move each adapter into its own worker (one per book × league) publishing normalized deltas to Redis/NATS; the web tier just fans out. Workers run on hosts each book accepts, which also decouples geo from where the site is served. Add history (ClickHouse/Timescale) off the same stream.
- **Entity matching** is what stops scaling by hand: nicknames are unique in the NFL but not across leagues (Giants, Cardinals, Rangers). A canonical entity store with per-book alias tables, where a fuzzy matcher proposes and a human approves, keeping the rule *never guess*.
- **Where AI helps:** (1) reconnaissance — reading a book's minified bundle for API hosts, auth, polling constants and the endpoint the client uses when it really cares about a price is exactly how FanDuel's price channel is found, and an agent can draft that brief from a HAR + bundle for a human to verify; (2) scaffolding an adapter + tests from captured payloads; (3) schema-drift watch — diff live payload shapes against fixtures nightly and open a PR when a field moves; the `invalidEntities` / `unresolved` counters are the alert signals; (4) entity resolution proposals. Not for the measurements — those come from scripts so they can be re-run, not believed.

## What I'd do next

- Record live-game latency over a full Sunday slate and publish the distribution, not just p50/p95.
- A feed audit (build a board from the DK socket alone for 20 min, compare to REST every 5 s) to prove zero missed deltas beyond the 60 s re-check counter.
- msgpack on the DK socket (what DK's own site uses) as a fallback if `format=json` ever goes away.
- "Who moved first" across the two books, and alt lines / props using the same adapters.
