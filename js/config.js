// Static configuration. Verified Nov 13, 2026 — re-check when things change.

// Books legally live for mobile betting in New York (8 licensed apps, Nov 2026).
// Resorts World Bet exited June 2025; ESPN BET became theScore Bet Dec 2025. bet365 / Hard Rock not live in NY.
export const NY_BOOKS = {
  fanduel: 'FanDuel',
  draftkings: 'DraftKings',
  betmgm: 'BetMGM',
  williamhill_us: 'Caesars',
  fanatics: 'Fanatics',
  betrivers: 'BetRivers',
  espnbet: 'theScore Bet',
  ballybet: 'Bally Bet',
};
// Prediction market the user chose to include. Not an NY-licensed sportsbook; NY regulators dispute it.
export const EXCHANGES = { kalshi: 'Kalshi' };
// Reference-only sharp books (never bettable from NY).
export const SHARP_REFS = { pinnacle: 'Pinnacle' };

export const BOOK_NAMES = { ...NY_BOOKS, ...EXCHANGES, ...SHARP_REFS };

// Up to 10 bookmakers in one call cost the same as one region on The Odds API.
export const DEFAULT_FETCH_BOOKS = ['pinnacle', 'fanatics', 'fanduel', 'kalshi', 'draftkings', 'betmgm', 'williamhill_us', 'betrivers', 'espnbet', 'ballybet'];
export const DEFAULT_MY_BOOKS = ['fanatics', 'fanduel', 'kalshi'];

export const SPORTS = [
  { key: 'americanfootball_nfl', short: 'NFL', college: false, markets: ['h2h', 'spreads', 'totals'] },
  { key: 'americanfootball_ncaaf', short: 'CFB', college: true, markets: ['h2h', 'spreads', 'totals'] },
  { key: 'basketball_nba', short: 'NBA', college: false, markets: ['h2h', 'spreads', 'totals'] },
  { key: 'basketball_ncaab', short: 'CBB', college: true, markets: ['h2h', 'spreads', 'totals'] },
  { key: 'soccer_epl', short: 'EPL', college: false, markets: ['h2h', 'spreads', 'totals'] },
];
export const SPORT_BY_KEY = Object.fromEntries(SPORTS.map((s) => [s.key, s]));

export const MAIN_MARKETS = new Set(['h2h', 'spreads', 'totals']);
// Derivative markets loadable per game (each market returned costs 1 credit).
export const DERIV_MARKETS = {
  americanfootball_nfl: ['team_totals', 'spreads_h1', 'totals_h1', 'h2h_h1', 'alternate_spreads', 'alternate_totals'],
  americanfootball_ncaaf: ['team_totals', 'spreads_h1', 'totals_h1', 'h2h_h1'],
  basketball_nba: ['team_totals', 'spreads_h1', 'totals_h1', 'spreads_q1', 'totals_q1', 'alternate_spreads', 'alternate_totals'],
  basketball_ncaab: ['team_totals', 'spreads_h1', 'totals_h1', 'h2h_h1'],
  soccer_epl: ['h2h_h1', 'totals_h1', 'btts', 'draw_no_bet', 'alternate_totals'],
};
export const MARKET_LABEL = {
  h2h: 'Moneyline', spreads: 'Spread', totals: 'Total', team_totals: 'Team total',
  spreads_h1: '1H spread', totals_h1: '1H total', h2h_h1: '1H moneyline', spreads_q1: '1Q spread', totals_q1: '1Q total',
  alternate_spreads: 'Alt spread', alternate_totals: 'Alt total', btts: 'Both teams score', draw_no_bet: 'Draw no bet',
};

// New York college teams: NY law bars bets on any game a NY college team plays, anywhere.
// College player props are banned in NY outright (never fetched here).
// Matched against the school part of feed team names.
export const NY_SCHOOLS = [
  /^Army\b/, /^Syracuse\b/, /^Buffalo Bulls\b/, /^Buffalo$/, /^(St\.?|Saint) John[’']?s\b(?!.*\(MN\))/, /^Columbia\b/, /^Cornell\b/, /^Fordham\b/,
  /^Hofstra\b/, /^Iona\b/, /^Manhattan\b/, /^Marist\b/, /^Niagara\b/, /^Canisius\b/, /^Siena\b/, /^St\.? Bonaventure\b/,
  /^Stony Brook\b/, /^Binghamton\b/, /^(UAlbany|Albany)\b/, /^(LIU|Long Island)\b/, /^Wagner\b/, /^Colgate\b/, /^Le Moyne\b/,
];
export const isNYSchool = (team) => NY_SCHOOLS.some((re) => re.test(team || ''));

export const NEWS_LINKS = {
  americanfootball_nfl: [['NFL injury report', 'https://www.nfl.com/injuries/']],
  basketball_nba: [['NBA official injury report', 'https://official.nba.com/nba-injury-report-2026-27/'], ['NBA.com', 'https://www.nba.com/news']],
  soccer_epl: [['Premier League news', 'https://www.premierleague.com/news']],
  americanfootball_ncaaf: [],
  basketball_ncaab: [],
};
// How long a "news checked" mark stays valid (hours).
export const NEWS_FRESH_HOURS = { americanfootball_nfl: 6, americanfootball_ncaaf: 6, basketball_nba: 1, basketball_ncaab: 3, soccer_epl: 1.5 };

// NFL home stadiums for weather. roof: 'open' gets a wind check; indoor/retractable are skipped.
// Neutral-site and international games will be wrong — they map to the listed home team's stadium.
export const NFL_STADIUMS = {
  'Arizona Cardinals': { roof: 'retractable' }, 'Atlanta Falcons': { roof: 'retractable' },
  'Baltimore Ravens': { roof: 'open', lat: 39.278, lon: -76.6227 }, 'Buffalo Bills': { roof: 'open', lat: 42.7738, lon: -78.787 },
  'Carolina Panthers': { roof: 'open', lat: 35.2258, lon: -80.8528 }, 'Chicago Bears': { roof: 'open', lat: 41.8623, lon: -87.6167 },
  'Cincinnati Bengals': { roof: 'open', lat: 39.0955, lon: -84.5161 }, 'Cleveland Browns': { roof: 'open', lat: 41.5061, lon: -81.6995 },
  'Dallas Cowboys': { roof: 'retractable' }, 'Denver Broncos': { roof: 'open', lat: 39.7439, lon: -105.0201 },
  'Detroit Lions': { roof: 'dome' }, 'Green Bay Packers': { roof: 'open', lat: 44.5013, lon: -88.0622 },
  'Houston Texans': { roof: 'retractable' }, 'Indianapolis Colts': { roof: 'retractable' },
  'Jacksonville Jaguars': { roof: 'open', lat: 30.3239, lon: -81.6373 }, 'Kansas City Chiefs': { roof: 'open', lat: 39.0489, lon: -94.4839 },
  'Las Vegas Raiders': { roof: 'dome' }, 'Los Angeles Chargers': { roof: 'dome' }, 'Los Angeles Rams': { roof: 'dome' },
  'Miami Dolphins': { roof: 'open', lat: 25.958, lon: -80.2389 }, 'Minnesota Vikings': { roof: 'dome' },
  'New England Patriots': { roof: 'open', lat: 42.0909, lon: -71.2643 }, 'New Orleans Saints': { roof: 'dome' },
  'New York Giants': { roof: 'open', lat: 40.8135, lon: -74.0745 }, 'New York Jets': { roof: 'open', lat: 40.8135, lon: -74.0745 },
  'Philadelphia Eagles': { roof: 'open', lat: 39.9008, lon: -75.1675 }, 'Pittsburgh Steelers': { roof: 'open', lat: 40.4468, lon: -80.0158 },
  'San Francisco 49ers': { roof: 'open', lat: 37.403, lon: -121.97 }, 'Seattle Seahawks': { roof: 'open', lat: 47.5952, lon: -122.3316 },
  'Tampa Bay Buccaneers': { roof: 'open', lat: 27.9759, lon: -82.5033 }, 'Tennessee Titans': { roof: 'open', lat: 36.1665, lon: -86.7713 },
  'Washington Commanders': { roof: 'open', lat: 38.9078, lon: -76.8645 },
};

export const BIAS_TEAMS = ['Los Angeles Chargers'];

export const DEFAULT_SETTINGS = {
  bankroll: 300,
  unit: 25,
  kellyMult: 0.25,
  maxBetPct: 0.02,
  dailyCapPct: 0.1,
  minStake: 1,
  bankrollMode: 'start+settled', // or 'fixed'
  evMain: 0.015,
  evDeriv: 0.04,
  evVerify: 0.08,
  staleMin: 10,
  devig: 'power',
  sharpBooks: ['pinnacle'],
  fetchBooks: DEFAULT_FETCH_BOOKS,
  myBooks: DEFAULT_MY_BOOKS,
  limited: [],
  limitedMode: 'exclude', // or 'rank-lower'
  kalshiFeeMult: 0.07,
  steamPp: 2.0,
  closeWindowMin: 10,
  historicalCloses: false,
  autoRefresh: false,
  autoRefreshMin: 30,
  autoDailyCredits: 15,
  showArbs: false,
  minConsensusBooks: 3,
  requireRobust: true,
  sports: SPORTS.map((s) => s.key),
};
