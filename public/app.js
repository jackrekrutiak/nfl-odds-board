// NFL odds board client. One EventSource; the server sends a snapshot, then deltas.
const BOOK_LABEL = { draftkings: 'DraftKings', fanduel: 'FanDuel' };
const BOOK_SHORT = { draftkings: 'DK', fanduel: 'FD' };
const MARKETS = ['spread', 'total', 'moneyline'];
const FLASH_MS = 2500;
const WAS_MS = 60_000;

const state = {
  view: readView(),
  games: new Map(), // gameKey -> { key, away, home, startTime, live, score, books:Set }
  quotes: new Map(), // quoteKey -> quote
  best: new Map(), // slot -> quoteKey | null
  moved: new Map(), // quoteKey -> { at, dir, prev }
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
    for (const [k, v] of Object.entries(d.best)) state.best.set(k, v);
    schedule();
  });
  es.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    state.health = d.health; state.metrics = d.metrics; state.lastFrameAt = Date.now();
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
  requestAnimationFrame(() => { pending = false; render(); });
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
  const chips = state.health.map((h) => {
    const age = h.lastContactTs ? fmtAge(serverNow() - h.lastContactTs) : 'never';
    const s = sortNum(state.lat[h.book]);
    const p50 = s.length ? `${fmtMs(pct(s, 0.5))} p50 to screen` : h.book === 'fanduel' ? '' : 'waiting for a move';
    const label = { live: h.transport === 'push' ? 'LIVE · push' : 'LIVE · poll', polling: 'POLLING', degraded: 'DEGRADED', stale: 'STALE', connecting: 'CONNECTING', disabled: 'OFF' }[h.state] ?? h.state;
    return `<span class="chip ${h.state}" title="${esc(h.lastError ?? h.detail ?? '')}"><span class="dot"></span><b>${BOOK_LABEL[h.book]}</b> ${label}
      <span class="m">contact ${age}${p50 ? ' · ' + p50 : ''}${h.detail && h.book === 'fanduel' ? ' · ' + esc(h.detail.split(' · ').slice(1).join(' · ')) : ''}</span></span>`;
  });
  const hop = sortNum(state.hop);
  chips.push(`<span class="chip ${streamAlive() ? 'live' : 'stale'}"><span class="dot"></span><b>This page</b> <span class="m">${streamAlive() ? `server → screen ${hop.length ? fmtMs(pct(hop, 0.5)) : '—'}` : 'reconnecting…'}</span></span>`);
  el.innerHTML = chips.join('');

  const banner = document.getElementById('banner');
  const bad = state.health.filter((h) => h.state === 'stale' || h.state === 'degraded');
  const msgs = bad.map((h) => `<b>${BOOK_LABEL[h.book]}</b> ${h.state === 'stale' ? 'is stale' : 'is having trouble'} — last confirmed ${h.lastContactTs ? fmtAge(serverNow() - h.lastContactTs) : 'never'}${h.lastError ? ` (${esc(h.lastError)})` : ''}. Its prices are greyed out; the other book keeps updating.`);
  if (!streamAlive() && state.lastFrameAt) msgs.unshift('Lost connection to the server — reconnecting. Numbers below are frozen.');
  banner.hidden = !msgs.length;
  banner.innerHTML = msgs.join('<br>');
  document.getElementById('conn').textContent = streamAlive() ? 'connected' : 'reconnecting';
}

function renderBoard() {
  const el = document.getElementById('board');
  const games = [...state.games.values()].filter((g) => hasAnyQuote(g.key)).sort((a, b) => a.startTime - b.startTime || a.key.localeCompare(b.key));
  if (!games.length) {
    el.innerHTML = `<p class="empty">${state.lastFrameAt ? 'No NFL game lines from either book right now.' : 'Connecting…'}</p>`;
    return;
  }
  let html = '';
  let day = '';
  for (const g of games) {
    const d = new Date(g.startTime).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (d !== day) {
      day = d;
      html += `<h3 class="day">${d}</h3><div class="colhead"><span></span><span>Spread</span><span>Total</span><span>Moneyline</span></div>`;
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
  const time = g.live
    ? `<span class="livetag">LIVE</span>${g.score?.period ? ' ' + esc(g.score.period) : ''}`
    : new Date(g.startTime).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const only = g.books.size === 1 ? ` · only on ${BOOK_LABEL[[...g.books][0]]}` : '';
  const row = (team, side, totalSide, score) => `
    <div class="team"><span class="abbr">${team.id}</span><span class="name">${esc(team.name)}</span>${score !== undefined ? `<span class="score">${score}</span>` : ''}</div>
    ${cellHtml(g.key, 'spread', side)}${cellHtml(g.key, 'total', totalSide)}${cellHtml(g.key, 'moneyline', side)}`;
  return `<article class="game"><div class="meta">${time}${only}</div>
    ${row(g.away, 'away', 'over', g.live ? g.score?.away : undefined)}
    ${row(g.home, 'home', 'under', g.live ? g.score?.home : undefined)}</article>`;
}

function cellHtml(gk, market, side) {
  let key;
  if (state.view === 'best') key = state.best.get(`${gk}|${market}|${side}`) ?? null;
  else key = `${gk}|${market}|${side}|${state.view}`;
  const q = key ? state.quotes.get(key) : null;
  if (!q) return `<div class="cell empty">—</div>`;
  const mv = state.moved.get(key);
  const now = Date.now();
  const flash = mv && now - mv.at < FLASH_MS ? (mv.dir > 0 ? ' up' : ' down') : '';
  const was = mv && now - mv.at < WAS_MS ? `<span class="was">${fmtLine(market, side, mv.prev.line)}${fmtPrice(mv.prev.american)}</span>` : '';
  const stale = bookIsStale(q.book) ? ' stale' : '';
  const susp = q.suspended ? ' susp' : '';
  const bk = state.view === 'best' ? `<span class="bk ${q.book}">${BOOK_LABEL[q.book]}</span>` : '';
  const flag = q.suspended ? '<span class="flag">SUSP</span>' : stale ? '<span class="flag">STALE</span>' : '';
  const title = `${BOOK_LABEL[q.book]} · implied ${(100 / q.decimal).toFixed(1)}% · last moved ${fmtAge(serverNow() - q.sourceTs)}${alt(gk, market, side, q.book)}`;
  return `<div class="cell${flash}${stale}${susp}" title="${esc(title)}">${flag}<span><span class="ln">${fmtLine(market, side, q.line)}</span><span class="px">${fmtPrice(q.american)}</span></span>${was}${bk}</div>`;
}

function alt(gk, market, side, book) {
  const other = book === 'draftkings' ? 'fanduel' : 'draftkings';
  const q = state.quotes.get(`${gk}|${market}|${side}|${other}`);
  return q ? ` · ${BOOK_LABEL[other]}: ${fmtLine(market, side, q.line)} ${fmtPrice(q.american)}` : '';
}

function renderMoves() {
  const el = document.getElementById('moves');
  if (!state.moves.length) { el.innerHTML = '<li class="t">Price changes from either book show up here as they happen.</li>'; return; }
  el.innerHTML = state.moves.map((m) => {
    const g = state.games.get(m.q.gameKey);
    const team = !g ? '' : m.q.side === 'over' ? 'Over' : m.q.side === 'under' ? 'Under' : g[m.q.side].id;
    const matchup = g ? `${g.away.id} @ ${g.home.id}` : '';
    return `<li><span class="t">${new Date(m.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span> <b>${BOOK_SHORT[m.q.book]}</b> ${matchup} · ${team} ${m.q.market}
      <br><span class="t">${fmtLine(m.q.market, m.q.side, m.prev.line)}${fmtPrice(m.prev.american)}</span> → <span class="${m.dir > 0 ? 'up' : 'down'}">${fmtLine(m.q.market, m.q.side, m.q.line)}${fmtPrice(m.q.american)}</span></li>`;
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
