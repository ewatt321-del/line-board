// Pure betting math. No DOM, no network. Tested in tests/math.test.mjs.
import { NFL_KEY } from './keynums.js';

// ---------- odds conversions ----------
export const amToDec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
export const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
export const probToAm = (p) => decToAm(1 / p);
export const fmtAm = (a) => (a == null || !isFinite(a) ? '—' : (a > 0 ? '+' : '') + Math.round(a));

// ---------- vig / hold ----------
export const overround = (q) => q.reduce((s, x) => s + x, 0);
// Theoretical hold: share of handle the book keeps on balanced action.
export const holdPct = (q) => 1 - 1 / overround(q);

function bisect(f, lo, hi, iters = 200) {
  let flo = f(lo);
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-13) return mid;
    if (fm > 0 === flo > 0) { lo = mid; flo = fm; } else hi = mid;
  }
  return (lo + hi) / 2;
}

export function devigMult(q) {
  const s = overround(q);
  return q.map((x) => x / s);
}

// Power method: p_i = q_i^k with sum(p) = 1. Handles 2- and 3-way markets.
export function devigPower(q) {
  if (q.some((x) => !(x > 0 && x < 1))) return null;
  const f = (k) => q.reduce((s, x) => s + Math.pow(x, k), 0) - 1;
  const k = bisect(f, 0.01, 60);
  const p = q.map((x) => Math.pow(x, k));
  const s = overround(p);
  return Math.abs(s - 1) < 1e-6 ? p : null;
}

// Shin (1993) method. Only defined when the book has positive overround.
export function devigShin(q) {
  const S = overround(q);
  if (!(S > 1) || q.some((x) => !(x > 0 && x < 1))) return null;
  const pz = (z) => q.map((x) => (Math.sqrt(z * z + (4 * (1 - z) * x * x) / S) - z) / (2 * (1 - z)));
  const z = bisect((z) => overround(pz(z)) - 1, 0, 0.49);
  const p = pz(z);
  return Math.abs(overround(p) - 1) < 1e-6 ? p : null;
}

// method: 'power' | 'shin' | 'mult'. Falls back to multiplicative if the solver fails.
export function devig(q, method = 'power') {
  let p = null;
  let used = method;
  if (method === 'power') p = devigPower(q);
  else if (method === 'shin') p = devigShin(q);
  if (!p) { p = devigMult(q); used = method === 'mult' ? 'mult' : method + '→mult'; }
  return { p, method: used, hold: holdPct(q) };
}

// Weighted no-vig consensus. books: [{p:[...], hold}] all describing the same outcomes in the same order.
// Lower-hold books get more weight (weight = 1/max(hold, 1%)).
export function consensus(books) {
  if (!books.length) return null;
  const n = books[0].p.length;
  const out = new Array(n).fill(0);
  let wsum = 0;
  for (const b of books) {
    const w = 1 / Math.max(b.hold, 0.01);
    wsum += w;
    for (let i = 0; i < n; i++) out[i] += w * b.p[i];
  }
  const p = out.map((x) => x / wsum);
  const s = overround(p);
  return p.map((x) => x / s);
}

// ---------- EV and sizing ----------
export const ev = (pFair, dec) => pFair * dec - 1; // EV% = fair prob x decimal odds - 1
export const kellyFull = (p, dec) => (p * dec - 1) / (dec - 1);

// Quarter-Kelly (or any multiplier) with per-bet and per-day caps. Returns dollars.
export function sizeBet({ p, dec, bankroll, kellyMult = 0.25, maxBetPct = 0.02, dailyCapPct = 0.1, stakedToday = 0, minStake = 0 }) {
  const full = Math.max(0, kellyFull(p, dec));
  const raw = bankroll * kellyMult * full;
  const capBet = bankroll * maxBetPct;
  const room = Math.max(0, bankroll * dailyCapPct - stakedToday);
  let stake = raw;
  let limitedBy = null;
  if (stake > capBet) { stake = capBet; limitedBy = 'per-bet cap'; }
  if (stake > room) { stake = room; limitedBy = 'daily cap'; }
  stake = Math.floor(stake * 100) / 100;
  return { stake, kellyFull: full, raw, limitedBy, belowMin: stake > 0 && stake < minStake };
}

// ---------- Kalshi ----------
// Taker fee per Kalshi's schedule: ceil(mult * C * P * (1-P)) to the cent, P = contract price in dollars.
export function kalshiFee(contracts, price, mult = 0.07) {
  return Math.ceil(mult * contracts * price * (1 - price) * 100 - 1e-9) / 100;
}
// Effective decimal odds after the taker fee, for a feed decimal price (1/P).
export function kalshiEffDec(dec, mult = 0.07) {
  const P = 1 / dec;
  return 1 / (P + mult * P * (1 - P));
}
export function kalshiOrder(stake, dec, mult = 0.07) {
  const P = Math.round((1 / dec) * 100) / 100;
  let c = Math.floor(stake / P);
  while (c > 0 && c * P + kalshiFee(c, P, mult) > stake + 1e-9) c--;
  const fee = kalshiFee(c, P, mult);
  const cost = c * P + fee;
  return { contracts: c, price: P, fee, cost, effDec: c > 0 ? c / cost : null };
}

// ---------- logit helpers ----------
const logit = (p) => Math.log(p / (1 - p));
const logistic = (x) => 1 / (1 + Math.exp(-x));

// ---------- NFL key numbers (real historical frequencies) ----------
function spreadBucket(S) {
  const b = Math.round(Math.min(20, Math.max(0, Math.abs(S))) * 2) / 2;
  return NFL_KEY.spreads[b.toFixed(1)];
}
function totalBucket(L) {
  const b = Math.round(Math.min(62, Math.max(30, L)) * 2) / 2;
  return NFL_KEY.totals[b.toFixed(1)];
}

// Win/push/loss for a team at spread point x, given the distribution of the favorite's margin.
function coverFromMargins(dist, teamIsFav, x) {
  const { p } = dist;
  const mMin = NFL_KEY.marginMin;
  let w = 0, push = 0, l = 0;
  for (let i = 0; i < p.length; i++) {
    const favMargin = mMin + i;
    const teamMargin = teamIsFav ? favMargin : -favMargin;
    const r = teamMargin + x;
    if (r > 0) w += p[i]; else if (r === 0) push += p[i]; else l += p[i];
  }
  return { w, push, l };
}
function overFromTotals(dist, side, line) {
  const { p } = dist;
  let w = 0, push = 0, l = 0;
  for (let t = 0; t < p.length; t++) {
    const pts = NFL_KEY.totalMin + t;
    const r = side === 'Over' ? pts - line : line - pts;
    if (r > 0) w += p[t]; else if (r === 0) push += p[t]; else l += p[t];
  }
  return { w, push, l };
}

// Move a fair no-push probability from the sharp line to another line for the same team,
// using the historical distribution of NFL margins for games with this spread.
// The market's view is kept by shifting the historical model in logit space.
export function nflSpreadAt({ x0, p0, x1 }) {
  const teamIsFav = x0 <= 0;
  const dist = spreadBucket(x0);
  const a = coverFromMargins(dist, teamIsFav, x0);
  const b = coverFromMargins(dist, teamIsFav, x1);
  const q0 = a.w / (a.w + a.l);
  const q1 = b.w / (b.w + b.l);
  const p1 = logistic(logit(q1) + logit(p0) - logit(q0));
  return { p: p1, push: b.push, pushAtSharp: a.push, n: dist.n };
}
export function nflTotalAt({ side, L0, p0, L1 }) {
  const dist = totalBucket(L0);
  const a = overFromTotals(dist, side, L0);
  const b = overFromTotals(dist, side, L1);
  const q0 = a.w / (a.w + a.l);
  const q1 = b.w / (b.w + b.l);
  return { p: logistic(logit(q1) + logit(p0) - logit(q0)), push: b.push, pushAtSharp: a.push, n: dist.n };
}
// Push probability at a line (for info), NFL only.
export function nflPushProb(market, point, sharpPoint) {
  if (market === 'spreads') {
    const teamIsFav = sharpPoint <= 0;
    return coverFromMargins(spreadBucket(sharpPoint), teamIsFav, point).push;
  }
  if (market === 'totals') return overFromTotals(totalBucket(sharpPoint), 'Over', point).push;
  return 0;
}

// Key numbers from the same historical data (most common final margins).
export const KEYS = {
  americanfootball_nfl: { spreads: [3, 7, 6, 10, 14, 4], totals: [41, 44, 37, 43, 47, 51, 40] },
  americanfootball_ncaaf: { spreads: [3, 7, 10, 14, 17, 21], totals: [] },
};
export function keyInfo(sport, market, linePoint, otherPoint) {
  const k = KEYS[sport]?.[market];
  if (!k || !k.length || linePoint == null) return null;
  const a = Math.abs(linePoint);
  const on = k.find((n) => Math.abs(a - n) <= 0.5);
  let crosses = null;
  if (otherPoint != null && otherPoint !== linePoint && Math.sign(otherPoint || linePoint) === Math.sign(linePoint || otherPoint)) {
    const b = Math.abs(otherPoint);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    crosses = k.find((n) => n >= lo && n <= hi && !(n === lo && n === hi)) ?? null;
  }
  if (on == null && crosses == null) return null;
  return { on, crosses };
}

// ---------- arbitrage / middles ----------
export function arb(decs) {
  const inv = decs.reduce((s, d) => s + 1 / d, 0);
  return { margin: 1 - inv, stakes: decs.map((d) => 1 / d / inv) };
}

// Probability both sides of a middle win (NFL only, historical margins).
// Spread middle: team A at +a (book 1) and team B at b (book 2), A's sharp point x0. Wins both when -a < marginA < b.
export function nflSpreadMiddleProb(x0, a, b) {
  const dist = spreadBucket(x0);
  const teamIsFav = x0 <= 0;
  let pr = 0;
  dist.p.forEach((pp, i) => {
    const fm = NFL_KEY.marginMin + i;
    const m = teamIsFav ? fm : -fm;
    if (m > -a && m < b) pr += pp;
  });
  return pr;
}
export function nflTotalMiddleProb(L0, over, under) {
  const dist = totalBucket(L0);
  let pr = 0;
  dist.p.forEach((pp, t) => { const pts = NFL_KEY.totalMin + t; if (pts > over && pts < under) pr += pp; });
  return pr;
}

// Parlay of independent legs: [{p, dec, overround}]
export function parlay(legs) {
  const dec = legs.reduce((s, l) => s * l.dec, 1);
  const p = legs.reduce((s, l) => s * l.p, 1);
  const S = legs.reduce((s, l) => s * (l.overround || 1), 1);
  return { dec, p, ev: p * dec - 1, hold: 1 - 1 / S };
}

// ---------- stats ----------
export function meanCI(xs) {
  const n = xs.length;
  if (!n) return { n: 0, mean: null, lo: null, hi: null };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { n, mean, lo: null, hi: null };
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, lo: mean - 1.96 * se, hi: mean + 1.96 * se };
}
