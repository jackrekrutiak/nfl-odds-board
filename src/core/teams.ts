import type { Team } from './types.js';

/**
 * Canonical NFL teams. Books spell teams differently ("DET Lions", "Detroit Lions",
 * "LA Chargers", "Los Angeles Chargers"). Every NFL nickname is unique, so we resolve on
 * the nickname, with a few explicit aliases. An unknown name is never guessed.
 */
const TEAMS: Array<[id: string, city: string, nickname: string, aliases?: string[]]> = [
  ['ARI', 'Arizona', 'Cardinals'],
  ['ATL', 'Atlanta', 'Falcons'],
  ['BAL', 'Baltimore', 'Ravens'],
  ['BUF', 'Buffalo', 'Bills'],
  ['CAR', 'Carolina', 'Panthers'],
  ['CHI', 'Chicago', 'Bears'],
  ['CIN', 'Cincinnati', 'Bengals'],
  ['CLE', 'Cleveland', 'Browns'],
  ['DAL', 'Dallas', 'Cowboys'],
  ['DEN', 'Denver', 'Broncos'],
  ['DET', 'Detroit', 'Lions'],
  ['GB', 'Green Bay', 'Packers'],
  ['HOU', 'Houston', 'Texans'],
  ['IND', 'Indianapolis', 'Colts'],
  ['JAX', 'Jacksonville', 'Jaguars', ['jags']],
  ['KC', 'Kansas City', 'Chiefs'],
  ['LV', 'Las Vegas', 'Raiders'],
  ['LAC', 'Los Angeles', 'Chargers'],
  ['LAR', 'Los Angeles', 'Rams'],
  ['MIA', 'Miami', 'Dolphins'],
  ['MIN', 'Minnesota', 'Vikings'],
  ['NE', 'New England', 'Patriots', ['pats']],
  ['NO', 'New Orleans', 'Saints'],
  ['NYG', 'New York', 'Giants'],
  ['NYJ', 'New York', 'Jets'],
  ['PHI', 'Philadelphia', 'Eagles'],
  ['PIT', 'Pittsburgh', 'Steelers'],
  ['SF', 'San Francisco', '49ers', ['niners', 'forty niners']],
  ['SEA', 'Seattle', 'Seahawks'],
  ['TB', 'Tampa Bay', 'Buccaneers', ['bucs']],
  ['TEN', 'Tennessee', 'Titans'],
  ['WAS', 'Washington', 'Commanders', ['football team']],
];

const byKey = new Map<string, Team>();
for (const [id, city, nickname, aliases = []] of TEAMS) {
  const team: Team = { id, name: `${city} ${nickname}`, short: nickname };
  for (const k of [nickname, `${city} ${nickname}`, id, ...aliases]) byKey.set(norm(k), team);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

export function resolveTeam(raw: string | undefined | null): Team | null {
  if (!raw) return null;
  const n = norm(raw);
  const direct = byKey.get(n);
  if (direct) return direct;
  // "DET Lions", "LA Chargers", "NY Jets": match on the trailing words.
  const words = n.split(' ');
  for (let i = 1; i < words.length; i++) {
    const t = byKey.get(words.slice(i).join(' '));
    if (t) return t;
  }
  return null;
}

export function allTeams(): Team[] {
  return [...new Set(byKey.values())];
}

/** Same game at any book → same key. Kickoff date is taken in US Eastern time, where NFL schedules live. */
const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

export function makeGameKey(away: Team, home: Team, startTime: number): string {
  const d = ET_DATE.format(new Date(startTime)); // formatter built once: constructing one costs far more than formatting
  return `nfl:${d}:${away.id}@${home.id}`;
}

/** "Detroit Lions @ Buffalo Bills" or "DET Lions @ BUF Bills" → [away, home] */
export function splitMatchup(name: string | undefined): [string, string] | null {
  if (!name) return null;
  const m = name.split(/\s+(?:@|at|vs\.?)\s+/i);
  return m.length === 2 && m[0] && m[1] ? [m[0], m[1]] : null;
}
