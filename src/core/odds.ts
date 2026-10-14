/** Odds helpers. Books disagree on formats (DK uses a Unicode minus, FD sends numbers). */

export function parseAmerican(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw !== 0 ? Math.round(raw) : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[−‒–—]/g, '-').replace(/^\+/, '');
  if (/^even$/i.test(s) || /^ev$/i.test(s)) return 100;
  const n = Number(s);
  return Number.isFinite(n) && n !== 0 ? Math.round(n) : null;
}

export function americanToDecimal(a: number): number {
  return round(a > 0 ? 1 + a / 100 : 1 + 100 / -a, 4);
}

export function decimalToAmerican(d: number): number {
  if (!(d > 1)) throw new Error(`bad decimal odds ${d}`);
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/** Prefer the book's exact decimal; fall back to its American display. */
export function toOdds(decimal: unknown, american: unknown): { american: number; decimal: number } | null {
  const d = typeof decimal === 'number' && decimal > 1 ? decimal : typeof decimal === 'string' && Number(decimal) > 1 ? Number(decimal) : null;
  const a = parseAmerican(american);
  if (a !== null) return { american: a, decimal: d !== null ? round(d, 4) : americanToDecimal(a) };
  if (d !== null) return { american: decimalToAmerican(d), decimal: round(d, 4) };
  return null;
}

export function impliedProb(decimal: number): number {
  return 1 / decimal;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
