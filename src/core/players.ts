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
