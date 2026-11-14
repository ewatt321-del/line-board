// Second-opinion model. Reads data/ratings.json (built daily by GitHub Actions) and turns
// team ratings into probabilities. It never puts a bet on the board by itself.
let R = null;

export async function loadRatings() {
  try {
    const r = await fetch(`data/ratings.json?v=${Date.now()}`, { cache: 'no-store' });
    R = r.ok ? await r.json() : null;
  } catch { R = null; }
  return R;
}
export const ratingsMeta = () => R;

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[’'.]/g, '').replace(/[-()]/g, ' ').replace(/\b(fc|afc)\b/g, ' ')
  .replace(/\bst\b/g, 'state').replace(/\s+/g, ' ').trim();

const ALIASES = {
  'los angeles clippers': 'la clippers',
  'uconn': 'connecticut', 'appalachian state': 'app state', 'massachusetts': 'umass', 'louisiana monroe': 'ul monroe',
  'southern mississippi': 'southern miss', 'sam houston state': 'sam houston', 'hawaii rainbow warriors': 'hawaii',
  // Odds API -> ESPN college basketball names
  'miss valley state': 'mississippi valley state', 'cal baptist': 'california baptist', 'loyola chi': 'loyola chicago',
  'loyola md': 'loyola maryland', 'n colorado': 'northern colorado', 'ut arlington': 'ut arlington', 'arkansas little rock': 'little rock',
  'seattle redhawks': 'seattle u redhawks', 'gardner webb bulldogs': 'gardner webb runnin bulldogs',
  'grand canyon antelopes': 'grand canyon lopes', 'nicholls state colonels': 'nicholls colonels', 'iupui jaguars': 'iu indy jaguars',
};

const indexCache = new Map();
function indexFor(sport) {
  if (indexCache.has(sport)) return indexCache.get(sport);
  const m = R?.sports?.[sport];
  if (!m) return null;
  const idx = new Map();
  for (const t of Object.keys(m.teams)) idx.set(norm(t), t);
  if (m.locations) for (const [t, loc] of Object.entries(m.locations)) if (loc && m.teams[t] && !idx.has(norm(loc))) idx.set(norm(loc), t);
  indexCache.set(sport, idx);
  return idx;
}

export function resolveTeam(sport, name) {
  const idx = indexFor(sport);
  if (!idx) return null;
  let n = norm(name);
  if (idx.has(n)) return idx.get(n);
  for (const [k, v] of Object.entries(ALIASES)) if (n === k || n.startsWith(k + ' ')) { n = n.replace(k, v); if (idx.has(n)) return idx.get(n); }
  // Prefix matching only for college football, where ratings use bare school names ("Ohio State").
  // Elsewhere names match exactly, and a prefix match could pick the wrong school ("Texas ..." -> Texas).
  if (sport !== 'americanfootball_ncaaf') return null;
  let best = null;
  for (const k of idx.keys()) if (k.length >= 3 && n.startsWith(k + ' ') && (!best || k.length > best.length)) best = k;
  return best ? idx.get(best) : null;
}

// Standard normal CDF.
function Phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

const MIN_GAMES = { americanfootball_nfl: 4, americanfootball_ncaaf: 4, basketball_nba: 6, basketball_ncaab: 5, soccer_epl: 5 };

function poisson(k, l) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
function dcMatrix(m, h, a) {
  const H = m.teams[h], A = m.teams[a];
  const lam = Math.exp(m.home + H.att + A.def), mu = Math.exp(A.att + H.def);
  const N = 11, M = [];
  for (let x = 0; x < N; x++) { M.push([]); for (let y = 0; y < N; y++) {
    let tau = 1;
    if (x === 0 && y === 0) tau = 1 - lam * mu * m.rho; else if (x === 0 && y === 1) tau = 1 + lam * m.rho;
    else if (x === 1 && y === 0) tau = 1 + mu * m.rho; else if (x === 1 && y === 1) tau = 1 - m.rho;
    M[x].push(Math.max(0, tau * poisson(x, lam) * poisson(y, mu)));
  } }
  return { M, lam, mu };
}
// Win/push/lose probability over a score matrix for f(x,y) > 0.
function wpl(M, f) {
  let w = 0, p = 0, l = 0;
  M.forEach((row, x) => row.forEach((pr, y) => { const v = f(x, y); if (v > 1e-9) w += pr; else if (v < -1e-9) l += pr; else p += pr; }));
  return { w, p, l };
}
// Asian lines: quarter lines are half on each neighbouring line; pushes refund.
function asian(fn, line) {
  const frac = Math.abs(line * 4) % 2;
  const lines = frac === 1 ? [line - 0.25, line + 0.25] : [line];
  const ps = lines.map((L) => { const r = fn(L); return r.w / (r.w + r.l); });
  return ps.reduce((s, x) => s + x, 0) / ps.length;
}

// Model view of a game, or null if either team is unrated.
export function modelGame(sport, homeName, awayName) {
  const m = R?.sports?.[sport];
  if (!m) return null;
  const h = resolveTeam(sport, homeName), a = resolveTeam(sport, awayName);
  if (!h || !a || !m.teams[h] || !m.teams[a]) return { missing: [(!h || !m.teams[h]) && homeName, (!a || !m.teams[a]) && awayName].filter(Boolean) };
  const nMin = Math.min(m.teams[h].n, m.teams[a].n);
  const low = nMin < (MIN_GAMES[sport] || 4);
  if (m.type === 'dixon-coles') {
    const { M, lam, mu } = dcMatrix(m, h, a);
    const r = wpl(M, (x, y) => x - y);
    return { type: 'dc', M, xgHome: lam, xgAway: mu, pHome: r.w, pDraw: r.p, pAway: r.l, low, nMin, stale: !!m.stale, updated: m.updated };
  }
  const H = m.teams[h], A = m.teams[a];
  const ph = m.mu + m.hfa + H.off - A.def, pa = m.mu + A.off - H.def;
  return { type: 'ridge', margin: ph - pa, total: ph + pa, sm: m.sigmaMargin, st: m.sigmaTotal, pHome: Phi((ph - pa) / m.sigmaMargin),
    low, nMin, stale: !!m.stale, updated: m.updated };
}

// Model probability (no-push) for one outcome. Main full-game markets only.
export function modelProb(g, sport, home, mk, name, point) {
  if (!g || g.missing) return null;
  if (g.type === 'dc') {
    if (mk === 'h2h') return name === home ? g.pHome : name === 'Draw' ? g.pDraw : g.pAway;
    if (mk === 'totals' && point != null) {
      const p = asian((L) => wpl(g.M, (x, y) => x + y - L), point);
      return name === 'Over' ? p : 1 - p;
    }
    if (mk === 'spreads' && point != null) {
      const isHome = name === home;
      return asian((L) => wpl(g.M, (x, y) => (isHome ? x - y : y - x) + L), point);
    }
    return null;
  }
  if (mk === 'h2h') return name === home ? g.pHome : 1 - g.pHome;
  if (mk === 'spreads' && point != null) { const tm = name === home ? g.margin : -g.margin; return Phi((tm + point) / g.sm); }
  if (mk === 'totals' && point != null) { const p = Phi((g.total - point) / g.st); return name === 'Over' ? p : 1 - p; }
  return null;
}

// Test hook.
export function setRatings(obj) { R = obj; indexCache.clear(); }
