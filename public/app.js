// NFL odds board client. One EventSource; the server sends a snapshot, then deltas.
const BOOK_LABEL = { draftkings: 'DraftKings', fanduel: 'FanDuel' };
const BOOK_SHORT = { draftkings: 'DK', fanduel: 'FD' };
const MARKETS = ['spread', 'total', 'moneyline'];
const FLASH_MS = 2600;
const BEST_MS = 3200;
const WAS_MS = 60_000;

const state = {
  view: readView(),
  games: new Map(), // gameKey -> { key, away, home, startTime, live, score, books:Set }
  quotes: new Map(), // quoteKey -> quote
  best: new Map(), // slot -> quoteKey | null
  moved: new Map(), // quoteKey -> { at, dir, prev }
  bestMoved: new Map(), // slot -> { at } when a different book takes the best line
  moves: [],
  health: [],
  metrics: null,
  lat: { draftkings: [], fanduel: [] }, // book → screen samples (ms)
  hop: [], // server → screen samples (ms)
  offset: 0, // serverClock - ourClock
  lastFrameAt: 0,
  connected: false,
};

/* ---------- clock ---------- */
async function syncClock() {
  let best = null;
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    try {
      const { serverTs } = await (await fetch('/api/time', { cache: 'no-store' })).json();
      const t1 = Date.now();
      if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: serverTs - (t0 + t1) / 2 };
    } catch { /* retry */ }
  }
  if (best) state.offset = best.offset;
}
const serverNow = () => Date.now() + state.offset;

/* ---------- stream ---------- */
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => { state.connected = true; schedule(); });
  es.addEventListener('error', () => { state.connected = false; schedule(); });
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    state.games.clear(); state.quotes.clear(); state.best.clear();
    for (const g of d.games) upsertGame(g);
    for (const q of d.quotes) state.quotes.set(qkey(q), q);
    for (const [k, v] of Object.entries(d.best)) state.best.set(k, v);
    state.health = d.health;
    // Line-movement feed survives a refresh: the server sends its recent moves with the snapshot.
    if (Array.isArray(d.moves)) {
      state.moves = d.moves.map((m) => ({
        at: m.at - state.offset, q: m.q, prev: m.prev,
        dir: m.q.line !== m.prev.line ? lineDir(m.q, m.prev) : m.q.american > m.prev.american ? 1 : -1,
      }));
    }
    state.lastFrameAt = Date.now();
    schedule();
  });
  es.addEventListener('delta', (e) => {
    const now = serverNow();
    const d = JSON.parse(e.data);
    state.lastFrameAt = Date.now();
    state.hop.push(now - d.emitTs); trim(state.hop);
    for (const g of d.games) upsertGame(g);
    for (const gk of d.removedGames) {
      const g = state.games.get(gk);
      if (g) { g.books.delete(d.book); if (!g.books.size) state.games.delete(gk); }
    }
    for (const c of d.changes) {
      if (!c.q) { state.quotes.delete(c.key); continue; }
      state.quotes.set(c.key, c.q);
      if (c.prev && (c.prev.american !== c.q.american || c.prev.line !== c.q.line)) {
        const dir = c.q.line !== c.prev.line ? lineDir(c.q, c.prev) : c.q.american > c.prev.american ? 1 : -1;
        state.moved.set(c.key, { at: Date.now(), dir, prev: c.prev });
        state.moves.unshift({ at: Date.now(), q: c.q, prev: c.prev, dir });
        // Only DraftKings stamps its changes; FanDuel's freshness is a stated bound, not a measurement.
        if (c.q.book === 'draftkings') { state.lat.draftkings.push(now - c.q.sourceTs); trim(state.lat.draftkings); }
      }
    }
    state.moves.length = Math.min(state.moves.length, 40);
    for (const [k, v] of Object.entries(d.best)) {
      const old = state.best.get(k);
      // A different book now has the best line: ring the cell so the change is seen.
      if (old && v && old !== v) state.bestMoved.set(k, { at: Date.now() });
      state.best.set(k, v);
    }
    schedule();
  });
  es.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    state.health = d.health; state.metrics = d.metrics; state.lastFrameAt = Date.now();
    state.hop.push(serverNow() - d.serverTs); trim(state.hop); // server → this screen, sampled every heartbeat
    schedule();
  });
}

function upsertGame(g) {
  const cur = state.games.get(g.gameKey) ?? { key: g.gameKey, books: new Set() };
  cur.away = g.away; cur.home = g.home;
  // Books disagree by a minute (FanDuel lists 1:01 for a 1:00 kickoff); show the earliest.
  cur.startTime = cur.startTime ? Math.min(cur.startTime, g.startTime) : g.startTime;
  cur.books.add(g.book);
  // Live if any book says live; score from whichever book has one.
  cur.liveBy = { ...(cur.liveBy ?? {}), [g.book]: g.live };
  cur.live = Object.values(cur.liveBy).some(Boolean);
  if (g.score) cur.score = g.score;
  state.games.set(g.gameKey, cur);
}

/* ---------- rendering ---------- */
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  const run = () => { pending = false; render(); };
  // rAF pauses in background tabs; fall back to a timer so the board never freezes there.
  if (document.visibilityState === 'visible') requestAnimationFrame(run);
  else setTimeout(run, 0);
}
setInterval(schedule, 1000); // ages, flash expiry

function render() {
  renderStatus();
  renderBoard();
  renderMoves();
}

function healthOf(book) { return state.health.find((h) => h.book === book); }
function bookIsStale(book) {
  const h = healthOf(book);
  return !h || h.state === 'stale' || h.state === 'degraded' || !streamAlive();
}
function streamAlive() { return state.connected && Date.now() - state.lastFrameAt < 15_000; }

function renderStatus() {
  const el = document.getElementById('status');
  const hop = sortNum(state.hop);
  const hopMs = hop.length ? Math.max(0, pct(hop, 0.5)) : 0;
  const chips = state.health.map((h) => {
    const confirmed = h.lastContactTs ? fmtAge(serverNow() - h.lastContactTs) : 'never';
    const label = { live: h.transport === 'push' ? 'LIVE · push' : 'LIVE · poll', polling: 'POLLING', degraded: 'DEGRADED', stale: 'STALE', connecting: 'CONNECTING', disabled: 'OFF' }[h.state] ?? h.state;
    // How old a number on screen is right now, per book:
    //  DraftKings stamps its changes, so: measured book → server (server metrics) + measured server → this screen.
    //  FanDuel stamps nothing, so: the stated bound (poll interval + round trip) + server → this screen.
    let fresh = '';
    if (h.book === 'draftkings') {
      const lat = state.metrics?.latency ?? {};
      const b2s = lat['draftkings|live|book_to_server'] ?? lat['draftkings|pregame|book_to_server'];
      fresh = b2s ? `≈ ${fmtMs(b2s.p50 + hopMs)} behind DraftKings` : 'waiting for a line move to measure';
    } else {
      const m = /age ≤ ([\d.]+) s/.exec(h.detail ?? '');
      fresh = m ? `≤ ${(Number(m[1]) + hopMs / 1000).toFixed(1)} s old` : '';
    }
    const stale = h.state === 'stale' || h.state === 'degraded';
    const short = { live: 'LIVE', polling: 'POLLING', degraded: 'DEGRADED', stale: 'STALE', connecting: 'CONNECTING', disabled: 'OFF' }[h.state] ?? h.state;
    return `<span class="chip ${h.state}" title="${esc(h.lastError ?? h.detail ?? '')}"><span class="dot"></span><span class="badge ${h.book}">${BOOK_SHORT[h.book]}</span><b>${BOOK_LABEL[h.book]}</b><span class="state">${short}${h.transport === 'push' ? ' · PUSH' : ' · POLL'}</span>
      <span class="m">${stale ? `numbers frozen · last confirmed ${confirmed}` : `${fresh} · confirmed ${confirmed}`}</span></span>`;
  });
  chips.push(`<span class="chip ${streamAlive() ? 'live' : 'stale'}"><span class="dot"></span><b>This page</b><span class="m">${streamAlive() ? `server → screen ${hop.length ? fmtMs(pct(hop, 0.5)) : '—'}` : 'reconnecting…'}</span></span>`);
  renderStats(hopMs);
  el.innerHTML = chips.join('');

  const banner = document.getElementById('banner');
  const bad = state.health.filter((h) => h.state === 'stale' || h.state === 'degraded');
  const msgs = bad.map((h) => `<b>${BOOK_LABEL[h.book]}</b> ${h.state === 'stale' ? 'is stale' : 'is having trouble'} — last confirmed ${h.lastContactTs ? fmtAge(serverNow() - h.lastContactTs) : 'never'}${h.lastError ? ` (${esc(h.lastError)})` : ''}. Its prices are greyed out; the other book keeps updating.`);
  if (!streamAlive() && state.lastFrameAt) msgs.unshift('Lost connection to the server — reconnecting. Numbers below are frozen.');
  banner.hidden = !msgs.length;
  banner.innerHTML = msgs.join('<br>');
  document.getElementById('conn').textContent = streamAlive() ? 'connected' : 'reconnecting';
}

function renderStats(hopMs) {
  const el = document.getElementById('stats');
  const games = [...state.games.values()].filter((g) => hasAnyQuote(g.key)).length;
  const live = state.health.filter((h) => h.state === 'live' || h.state === 'polling').length;
  const lat = state.metrics?.latency ?? {};
  const b2s = lat['draftkings|live|book_to_server'] ?? lat['draftkings|pregame|book_to_server'];
  el.innerHTML = [
    `<span class="${live === state.health.length && live ? 'ok' : ''}"><b>${live}/${state.health.length || 2}</b> books live</span>`,
    `<span><b>${games}</b> games</span>`,
    `<span><b>${state.quotes.size}</b> prices</span>`,
    `<span class="ok">refresh <b>${b2s ? fmtMs(b2s.p50 + hopMs) : '—'}</b></span>`,
  ].join('');
}

function renderBoard() {
  const el = document.getElementById('board');
  const games = [...state.games.values()].filter((g) => hasAnyQuote(g.key)).sort((a, b) => a.startTime - b.startTime || a.key.localeCompare(b.key));
  if (!games.length) {
    el.innerHTML = `<p class="empty">${state.lastFrameAt ? 'No NFL game lines from either book right now.' : 'Connecting…'}</p>`;
    return;
  }
  // In-progress games are pinned in their own band at the top; everything else is grouped by day.
  const live = games.filter((g) => g.live);
  const upcoming = games.filter((g) => !g.live);
  const bar = (label, cls = '') => `<div class="daybar${cls}"><span class="day">${label}</span><span>Spread</span><span>Total</span><span>Moneyline</span></div>`;
  let html = '';
  if (live.length) {
    html += bar(`<span class="live-dot" aria-hidden="true"></span>Live now <span class="count">${live.length}</span>`, ' livebar');
    for (const g of live) html += gameHtml(g);
  }
  let day = '';
  for (const g of upcoming) {
    const d = new Date(g.startTime).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (d !== day) {
      day = d;
      html += bar(d);
    }
    html += gameHtml(g);
  }
  el.innerHTML = html;
}

function hasAnyQuote(gk) {
  for (const k of state.quotes.keys()) if (k.startsWith(gk + '|')) return true;
  return false;
}

function gameHtml(g) {
  const when = g.live
    ? `<span class="livetag">LIVE</span>${g.score?.period ? `<span>${esc(g.score.period)}</span>` : ''}`
    : `<span>${new Date(g.startTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>`;
  const only = g.books.size === 1 ? `<span class="only">${BOOK_SHORT[[...g.books][0]]} only</span>` : '';
  const team = (t, score) => `<div class="team"><span class="abbr">${t.id}</span><span class="name">${esc(t.name)}</span>${score !== undefined ? `<span class="score">${score}</span>` : ''}</div>`;
  return `<article class="game${g.live ? ' is-live' : ''}">
    <div class="when">${when}${only}</div>
    ${team(g.away, g.live ? g.score?.away : undefined)}
    ${cellHtml(g.key, 'spread', 'away')}${cellHtml(g.key, 'total', 'over')}${cellHtml(g.key, 'moneyline', 'away')}
    ${team(g.home, g.live ? g.score?.home : undefined)}
    ${cellHtml(g.key, 'spread', 'home')}${cellHtml(g.key, 'total', 'under')}${cellHtml(g.key, 'moneyline', 'home')}
  </article>`;
}

function cellHtml(gk, market, side) {
  const slot = `${gk}|${market}|${side}`;
  const bestKey = state.best.get(slot) ?? null;
  const key = state.view === 'best' ? bestKey : `${slot}|${state.view}`;
  const q = key ? state.quotes.get(key) : null;
  if (!q) return `<div class="cell empty">—</div>`;
  const now = Date.now();
  const other = state.quotes.get(`${slot}|${q.book === 'draftkings' ? 'fanduel' : 'draftkings'}`);
  // "Best" is marked only when it beats the other book; a tie is not an edge.
  const isBest = key === bestKey && !q.suspended && !bookIsStale(q.book) && other && !other.suspended && (other.american !== q.american || other.line !== q.line);
  const mv = state.moved.get(key);
  const sinceMove = mv ? now - mv.at : Infinity;
  const bm = state.bestMoved.get(slot);
  const sinceBest = bm ? now - bm.at : Infinity;
  const cls = ['cell'];
  const style = [];
  if (isBest) cls.push('best');
  if (sinceMove < FLASH_MS) { cls.push(mv.dir > 0 ? 'flash-up' : 'flash-down'); style.push(`animation-delay:-${sinceMove}ms`); }
  if (sinceBest < BEST_MS) { cls.push('best-new'); style.push(`--bt:-${sinceBest}ms`); }
  if (bookIsStale(q.book)) cls.push('stale');
  if (q.suspended) cls.push('susp');
  const arrow = sinceMove < WAS_MS ? `<span class="arrow ${mv.dir > 0 ? 'up' : 'down'}">${mv.dir > 0 ? '▲' : '▼'}</span>` : '';
  const was = sinceMove < WAS_MS ? `<span class="was" title="previous price">${fmtLine(market, side, mv.prev.line)}${fmtPrice(mv.prev.american)}</span>` : '';
  const flag = q.suspended ? '<span class="flag">SUSP</span>' : bookIsStale(q.book) ? '<span class="flag">STALE</span>' : '';
  const title = `${BOOK_LABEL[q.book]}${isBest ? ' · best line' : ''} · implied ${(100 / q.decimal).toFixed(1)}% · last moved ${fmtAge(serverNow() - q.sourceTs)}${other ? ` · ${BOOK_LABEL[other.book]}: ${fmtLine(market, side, other.line)}${fmtPrice(other.american)}` : ''}`;
  return `<div class="${cls.join(' ')}"${style.length ? ` style="${style.join(';')}"` : ''} title="${esc(title)}">${flag}
    <span class="val"><span class="ln">${fmtLine(market, side, q.line).trim() || (was ? '' : '&nbsp;')}${was}</span><span class="px">${fmtPrice(q.american)} ${arrow}</span></span>
    <span class="side">${isBest ? '<span class="star" aria-label="best line">★</span>' : ''}<span class="badge ${q.book}">${BOOK_SHORT[q.book]}</span></span>
  </div>`;
}

function renderMoves() {
  const el = document.getElementById('moves');
  if (!state.moves.length) { el.innerHTML = '<li class="hint">Every price change from either book appears here the moment it lands.</li>'; return; }
  const now = Date.now();
  el.innerHTML = state.moves.map((m) => {
    const g = state.games.get(m.q.gameKey);
    const team = !g ? '' : m.q.side === 'over' ? 'Over' : m.q.side === 'under' ? 'Under' : g[m.q.side].id;
    const matchup = g ? `${g.away.id} @ ${g.home.id}` : '';
    const since = now - m.at;
    const mk = { spread: 'spread', total: 'total', moneyline: 'ML' }[m.q.market];
    return `<li${since < FLASH_MS ? ` class="fresh" style="animation-delay:-${since}ms"` : ''}><span class="badge ${m.q.book}">${BOOK_SHORT[m.q.book]}</span><span class="what"><b>${team}</b> ${mk} · ${matchup}</span><span class="t">${fmtAge(serverNow() - (m.at + state.offset)).replace(' ago', '')}</span>
      <span class="chg">${fmtLine(m.q.market, m.q.side, m.prev.line)}${fmtPrice(m.prev.american)} → <span class="${m.dir > 0 ? 'up' : 'down'}">${fmtLine(m.q.market, m.q.side, m.q.line)}${fmtPrice(m.q.american)} ${m.dir > 0 ? '▲' : '▼'}</span></span></li>`;
  }).join('');
}

/* ---------- formatting ---------- */
function fmtPrice(a) { return a > 0 ? `+${a}` : `${a}`; }
function fmtLine(market, side, line) {
  if (line === null || line === undefined || market === 'moneyline') return '';
  if (market === 'total') return `${side === 'over' ? 'O' : 'U'} ${line} `;
  return line === 0 ? 'PK ' : `${line > 0 ? '+' : ''}${line} `;
}
function fmtAge(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  return `${Math.round(ms / 3_600_000)} h ago`;
}
function fmtMs(ms) { return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`; }
function lineDir(q, prev) {
  // Better line for the bettor = up (green): spread number higher, Over total lower, Under total higher.
  if (q.market === 'total') return (q.side === 'over' ? prev.line - q.line : q.line - prev.line) > 0 ? 1 : -1;
  return q.line - prev.line > 0 ? 1 : -1;
}
function qkey(q) { return `${q.gameKey}|${q.market}|${q.side}|${q.book}`; }
function trim(a) { if (a.length > 300) a.splice(0, a.length - 300); }
function sortNum(a) { return [...(a ?? [])].sort((x, y) => x - y); }
function pct(s, p) { return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

/* ---------- view toggle ---------- */
function readView() {
  const v = new URLSearchParams(location.search).get('view');
  if (['best', 'draftkings', 'fanduel'].includes(v)) return v;
  try { return localStorage.getItem('view') ?? 'best'; } catch { return 'best'; }
}
for (const b of document.querySelectorAll('.toggle button')) {
  b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  b.addEventListener('click', () => {
    state.view = b.dataset.view;
    try { localStorage.setItem('view', state.view); } catch { /* private mode */ }
    for (const x of document.querySelectorAll('.toggle button')) x.setAttribute('aria-selected', String(x === b));
    schedule();
  });
}

syncClock().finally(connect);
setInterval(syncClock, 5 * 60_000);
