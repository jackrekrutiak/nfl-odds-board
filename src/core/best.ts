import type { Quote } from './types.js';

/**
 * "Best price" when books are on different lines.
 *
 * The call: the line comes first, the price breaks ties.
 *   - Spread: a higher number is better for the side holding it (+3.5 beats +3, -3 beats -3.5).
 *   - Total: Over wants the lower total, Under the higher one.
 *   - Same line: the higher decimal price wins.
 *
 * So for -3 -110 vs -3.5 +100, -3 -110 is best. A half point is worth more than ~10 cents of
 * juice almost everywhere in the NFL (and far more on 3 and 7), and line shoppers shop the
 * number first. The exception worth naming: a half point between non-key numbers can be worth
 * less than a big price gap (e.g. -5.5 -105 vs -6 +120). We cap that: if the worse line pays
 * at least MAX_HALF_POINT_CENTS more per half point, the price wins. Both quotes are always
 * visible on the per-book views, so nothing is hidden by this choice.
 */
const MAX_HALF_POINT_CENTS = 20; // ~ cost of a non-key half point in the NFL

export function pickBest(quotes: Quote[]): Quote | null {
  const live = quotes.filter((q) => !q.suspended);
  if (live.length === 0) return null;
  return live.reduce((a, b) => (compare(b, a) > 0 ? b : a));
}

/** > 0 if `a` is better for the bettor than `b`. */
export function compare(a: Quote, b: Quote): number {
  const lineDiff = lineAdvantage(a, b);
  const priceDiff = cents(a.american) - cents(b.american);
  if (lineDiff === 0) return priceDiff;
  const halfPoints = Math.abs(lineDiff) * 2;
  const crossesKey = crossesKeyNumber(a, b);
  // The quote with the better line wins unless the other pays enough more per half point.
  const lineWinner = lineDiff > 0 ? 1 : -1;
  const priceEdgeForLoser = -lineWinner * priceDiff; // cents the worse-line quote pays extra
  if (!crossesKey && priceEdgeForLoser >= MAX_HALF_POINT_CENTS * halfPoints) return -lineWinner;
  return lineWinner;
}

/** Points of line advantage `a` has over `b` (positive = a's line is better). */
function lineAdvantage(a: Quote, b: Quote): number {
  if (a.line === null || b.line === null) return 0;
  if (a.market === 'spread') return a.line - b.line;
  if (a.market === 'total') return a.side === 'over' ? b.line - a.line : a.line - b.line;
  // Player over/unders work like totals: the Over wants the lower line, the Under the higher.
  if (a.market.startsWith('prop:')) return a.side.endsWith(':over') ? b.line - a.line : a.line - b.line;
  return 0;
}

/** American odds on a continuous "cents" scale: -110 → -10, +100 → 0, +120 → 20. */
function cents(american: number): number {
  return american >= 100 ? american - 100 : american + 100;
}

const KEY_SPREADS = [3, 7];
function crossesKeyNumber(a: Quote, b: Quote): boolean {
  if (a.market !== 'spread' || a.line === null || b.line === null) return false;
  const lo = Math.min(Math.abs(a.line), Math.abs(b.line));
  const hi = Math.max(Math.abs(a.line), Math.abs(b.line));
  return KEY_SPREADS.some((k) => lo <= k && hi >= k && lo !== hi);
}
