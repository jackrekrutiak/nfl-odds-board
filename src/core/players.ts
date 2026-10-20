/** Player matching across books: one key per player, however a book spells the name. */
const SUFFIX = /\s+(jr|sr|ii|iii|iv|v)\.?$/i;

/** "Luther Burden III" → "luther-burden"; "D'Andre Swift" → "dandre-swift"; "A.J. Brown" → "aj-brown". */
export function playerKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(SUFFIX, '')
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** One name per stat across books. Over/under props key as market `prop:<stat>`, side `p:<player>:over|under`. */
export const STATS: Record<string, string> = {
  passing_yds: 'Passing yds',
  passing_tds: 'Passing TDs',
  pass_completions: 'Completions',
  pass_attempts: 'Pass attempts',
  interceptions: 'Interceptions',
  rushing_yds: 'Rushing yds',
  rush_attempts: 'Rush attempts',
  receiving_yds: 'Receiving yds',
  receptions: 'Receptions',
  rush_rec_yds: 'Rush + rec yds',
};

export const isOverUnderProp = (market: string): boolean => market.startsWith('prop:');
