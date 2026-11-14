// Turns raw Odds API events into priced rows: fair value from the sharp book (or a consensus),
// best price at the user's books, EV, and pricing method for every row.
import { amToDec, kalshiEffDec, devig, consensus, holdPct, nflSpreadAt, nflTotalAt, nflPushProb, keyInfo,
  nflSpreadMiddleProb, nflTotalMiddleProb, arb } from './math.js';
import { BOOK_NAMES, MAIN_MARKETS, BIAS_TEAMS, isNYSchool, SPORT_BY_KEY } from './config.js';

const isSoccer = (sport) => sport.startsWith('soccer');
const outcomeCount = (sport, mk) => (isSoccer(sport) && (mk === 'h2h' || mk === 'h2h_h1') ? 3 : 2);
export const sideKey = (o) => `${o.desc || ''}|${o.name}`;
const baseMarket = (mk) => (mk.includes('spread') ? 'spreads' : mk.includes('total') && !mk.startsWith('team') ? 'totals' : mk);

// Outcomes of the same line share a pair key. Spreads are oriented to the home team's point.
export function pairKey(o, ev) {
  if (o.desc) return `d|${o.desc}|${o.point ?? ''}`;
  if (o.point == null) return 'ml';
  if (o.name === 'Over' || o.name === 'Under') return `t|${o.point}`;
  return `s|${o.name === ev.home_team ? o.point : -o.point}`;
}

function normBook(bk, m, s) {
  return {
    lastUpdate: m.last_update || null,
    outcomes: m.outcomes.map((o) => {
      const dec = amToDec(o.price);
      return { name: o.name, desc: o.description || null, point: o.point ?? null, am: o.price, dec,
        effDec: bk === 'kalshi' ? kalshiEffDec(dec, s.kalshiFeeMult) : dec };
    }),
  };
}

function pairsOf(book, ev) {
  const m = new Map();
  for (const o of book.outcomes) {
    const k = pairKey(o, ev);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(o);
  }
  for (const outs of m.values()) outs.sort((a, b) => sideKey(a).localeCompare(sideKey(b)));
  return m;
}

// Fair probabilities for every line the reference has. Returns {source, method, pairs: Map(key -> {outcomes:[{...,p}], hold})}
export function fairFor(sport, mk, books, ev, s, method = s.devig) {
  const n = outcomeCount(sport, mk);
  for (const sb of s.sharpBooks) {
    if (!books[sb]) continue;
    const pairs = new Map();
    for (const [k, outs] of pairsOf(books[sb], ev)) {
      if (outs.length !== n) continue;
      const d = devig(outs.map((o) => 1 / o.dec), method);
      pairs.set(k, { key: k, hold: d.hold, method: d.method, outcomes: outs.map((o, i) => ({ ...o, p: d.p[i] })) });
    }
    if (pairs.size) return { source: BOOK_NAMES[sb] || sb, sharp: true, method: `${method} no-vig`, nBooks: 1, pairs, lastUpdate: books[sb].lastUpdate };
  }
  // No sharp book: weighted no-vig consensus of the other books (Kalshi excluded).
  const acc = new Map();
  for (const bk of Object.keys(books)) {
    if (bk === 'kalshi' || s.sharpBooks.includes(bk)) continue;
    for (const [k, outs] of pairsOf(books[bk], ev)) {
      if (outs.length !== n) continue;
      const d = devig(outs.map((o) => 1 / o.dec), method);
      if (!acc.has(k)) acc.set(k, []);
      // Books on a shared feed post identical prices; count them once.
      const sig = outs.map((o) => o.am).join(',');
      if (acc.get(k).some((x) => x.sig === sig)) { acc.get(k).find((x) => x.sig === sig).bk += `+${bk}`; continue; }
      acc.get(k).push({ p: d.p, hold: d.hold, outs, bk, sig });
    }
  }
  const pairs = new Map();
  for (const [k, list] of acc) {
    if (list.length < 2) continue;
    const p = consensus(list);
    pairs.set(k, { key: k, hold: null, books: list.map((x) => x.bk),
      outcomes: list[0].outs.map((o, i) => ({ name: o.name, desc: o.desc, point: o.point, p: p[i] })) });
  }
  if (!pairs.size) return null;
  const nBooks = Math.max(...[...pairs.values()].map((x) => x.books.length));
  return { source: `Consensus (${nBooks} independent book${nBooks > 1 ? 's' : ''})`, sharp: false, nBooks, method: `weighted ${method} no-vig consensus`, pairs };
}

// Price one offered outcome against the fair reference.
export function priceOutcome(o, fair, sport, mk, ev) {
  if (!fair) return null;
  const fp = fair.pairs.get(pairKey(o, ev));
  if (fp) {
    const fo = fp.outcomes.find((x) => x.name === o.name && x.desc === o.desc);
    if (fo) {
      const push = sport === 'americanfootball_nfl' && o.point != null && (mk === 'spreads' || mk === 'totals')
        ? nflPushProb(mk, o.point, fo.point) : null;
      return { p: fo.p, kind: 'exact', fairPoint: fo.point, push };
    }
  }
  if (o.point == null) return null;
  let best = null;
  for (const pr of fair.pairs.values()) for (const fo of pr.outcomes) {
    if (fo.name !== o.name || fo.desc !== o.desc || fo.point == null) continue;
    const d = Math.abs(fo.point - o.point);
    if (!best || d < best.d) best = { fo, d };
  }
  if (!best) return null;
  const { fo } = best;
  const bm = baseMarket(mk);
  if (sport === 'americanfootball_nfl' && !mk.includes('_h1') && !mk.includes('_q') && !o.desc) {
    if (bm === 'spreads') { const r = nflSpreadAt({ x0: fo.point, p0: fo.p, x1: o.point }); return { p: r.p, kind: 'keyadj', fairPoint: fo.point, push: r.push }; }
    if (bm === 'totals') { const r = nflTotalAt({ side: o.name, L0: fo.point, p0: fo.p, L1: o.point }); return { p: r.p, kind: 'keyadj', fairPoint: fo.point, push: r.push }; }
  }
  // Other sports: only price a different line when it is strictly better for the bettor (gives a lower bound).
  const better = o.name === 'Over' ? o.point < fo.point : o.name === 'Under' ? o.point > fo.point : o.point > fo.point;
  if (better) return { p: fo.p, kind: 'bound', fairPoint: fo.point, push: null };
  return { p: null, kind: 'worse-line', fairPoint: fo.point, push: null };
}

// Build everything for one event.
export function analyzeEvent(ev, s) {
  const sport = ev.sport_key;
  const out = { id: ev.id, sport, home: ev.home_team, away: ev.away_team, commence: ev.commence_time, markets: {}, rows: [] };
  if (SPORT_BY_KEY[sport]?.college && (isNYSchool(ev.home_team) || isNYSchool(ev.away_team))) { out.nyBlocked = true; return out; }
  const byMk = {};
  for (const b of ev.bookmakers || []) for (const m of b.markets || []) {
    (byMk[m.key] ||= {})[b.key] = normBook(b.key, m, s);
  }
  const mine = s.myBooks.filter((b) => !(s.limited.includes(b) && s.limitedMode === 'exclude'));
  for (const [mk, books] of Object.entries(byMk)) {
    const fair = fairFor(sport, mk, books, ev, s);
    const alts = ['power', 'shin', 'mult'].filter((m) => m !== s.devig).map((m) => fairFor(sport, mk, books, ev, s, m));
    const holds = {};
    for (const [bk, book] of Object.entries(books)) {
      const hs = [...pairsOf(book, ev).values()].filter((x) => x.length === outcomeCount(sport, mk)).map((x) => holdPct(x.map((o) => 1 / o.dec)));
      if (hs.length) holds[bk] = hs[0];
    }
    out.markets[mk] = { fair, books, holds };
    const groups = new Map();
    for (const bk of mine) {
      if (!books[bk]) continue;
      for (const o of books[bk].outcomes) {
        const pr = priceOutcome(o, fair, sport, mk, ev);
        const isAlt = mk.startsWith('alternate');
        const gk = sideKey(o) + (isAlt ? `|${o.point}` : '');
        const evPct = pr?.p != null ? pr.p * o.effDec - 1 : null;
        const rank = evPct == null ? -Infinity : evPct - (s.limited.includes(bk) ? 1 : 0);
        const cand = { bk, o, pr, ev: evPct, rank, lastUpdate: books[bk].lastUpdate };
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push(cand);
      }
    }
    // Make sure every fair side shows up even if none of the user's books has it.
    if (fair && !mk.startsWith('alternate')) for (const pr of fair.pairs.values()) for (const fo of pr.outcomes) {
      if (!groups.has(sideKey(fo))) groups.set(sideKey(fo), []);
    }
    for (const [gk, cands] of groups) {
      cands.sort((a, b) => b.rank - a.rank);
      const top = cands[0] || null;
      const [desc, name] = gk.split('|');
      const sharpRef = fair ? [...fair.pairs.values()].flatMap((p) => p.outcomes).find((x) => sideKey(x) === `${desc}|${name}`) : null;
      const main = MAIN_MARKETS.has(mk);
      const row = {
        id: `${ev.id}|${mk}|${gk}`, eventId: ev.id, sport, home: ev.home_team, away: ev.away_team, commence: ev.commence_time,
        mk, main, name, desc: desc || null,
        book: top?.bk ?? null, point: top?.o.point ?? sharpRef?.point ?? null, am: top?.o.am ?? null, dec: top?.o.dec ?? null, effDec: top?.o.effDec ?? null,
        p: top?.pr?.p ?? null, kind: top?.pr?.kind ?? (fair ? 'no-book' : 'no-fair'), push: top?.pr?.push ?? null,
        fairPoint: top?.pr?.fairPoint ?? sharpRef?.point ?? null, fairP: sharpRef?.p ?? null,
        fairSource: fair?.source ?? null, fairMethod: fair?.method ?? null, sharp: !!fair?.sharp,
        ev: top?.ev ?? null, lastUpdate: top?.lastUpdate ?? null, cands,
      };
      row.threshold = main ? s.evMain : s.evDeriv;
      // Same bet under the other de-vig methods: an edge that only exists under one method isn't trustworthy.
      if (top && row.ev != null) {
        const evs = [row.ev];
        for (const f of alts) { const pr = priceOutcome(top.o, f, sport, mk, ev); if (pr?.p != null) evs.push(pr.p * top.o.effDec - 1); }
        row.evMin = Math.min(...evs); row.evMax = Math.max(...evs);
      }
      row.robust = row.evMin == null || row.evMin >= row.threshold;
      row.weakFair = !!fair && !fair.sharp && (fair.nBooks || 0) < (s.minConsensusBooks ?? 3);
      row.flags = {
        verify: main && row.ev != null && row.ev > s.evVerify,
        bias: BIAS_TEAMS.some((t) => t === ev.home_team || t === ev.away_team),
        key: ['spreads', 'totals', 'alternate_spreads', 'alternate_totals'].includes(mk) ? keyInfo(sport, baseMarket(mk), row.point, row.fairPoint) : null,
        limited: row.book ? s.limited.includes(row.book) : false,
        kalshi: row.book === 'kalshi',
      };
      out.rows.push(row);
    }
  }
  return out;
}

// Arbs and middles across the user's (non-limited) books, main markets only.
export function arbsAndMiddles(an, s) {
  const res = [];
  const mine = s.myBooks.filter((b) => !s.limited.includes(b));
  for (const mk of ['h2h', 'spreads', 'totals']) {
    const m = an.markets[mk];
    if (!m) continue;
    const offers = [];
    for (const bk of mine) for (const o of m.books[bk]?.outcomes || []) offers.push({ bk, o });
    if (mk === 'h2h') {
      const names = [...new Set(offers.map((x) => x.o.name))];
      const best = names.map((n) => offers.filter((x) => x.o.name === n).sort((a, b) => b.o.effDec - a.o.effDec)[0]);
      if (best.length === outcomeCount(an.sport, mk) && new Set(best.map((b) => b.bk)).size > 1) {
        const a = arb(best.map((b) => b.o.effDec));
        if (a.margin > 0) res.push({ type: 'arb', an, mk, legs: best, margin: a.margin, stakes: a.stakes });
      }
      continue;
    }
    for (let i = 0; i < offers.length; i++) for (let j = 0; j < offers.length; j++) {
      const A = offers[i], B = offers[j];
      if (A.bk === B.bk || A.o.name === B.o.name) continue;
      if (mk === 'spreads') {
        const window = A.o.point + B.o.point; // >0 means a middle exists
        const a = arb([A.o.effDec, B.o.effDec]);
        if (window > 0 && i < j || (window === 0 && a.margin > 0 && i < j)) {
          let prob = null;
          const sharpA = m.fair?.pairs ? [...m.fair.pairs.values()].flatMap((p) => p.outcomes).find((x) => x.name === A.o.name) : null;
          if (an.sport === 'americanfootball_nfl' && sharpA && window > 0) prob = nflSpreadMiddleProb(sharpA.point, A.o.point, B.o.point);
          res.push({ type: window > 0 ? 'middle' : 'arb', an, mk, legs: [A, B], window, margin: a.margin, stakes: a.stakes, prob });
        }
      } else if (mk === 'totals' && A.o.name === 'Over' && B.o.name === 'Under') {
        const window = B.o.point - A.o.point;
        const a = arb([A.o.effDec, B.o.effDec]);
        if (window > 0 || (window === 0 && a.margin > 0)) {
          let prob = null;
          const sharpO = m.fair?.pairs ? [...m.fair.pairs.values()].flatMap((p) => p.outcomes).find((x) => x.name === 'Over') : null;
          if (an.sport === 'americanfootball_nfl' && sharpO && window > 0) prob = nflTotalMiddleProb(sharpO.point, A.o.point, B.o.point);
          res.push({ type: window > 0 ? 'middle' : 'arb', an, mk, legs: [A, B], window, margin: a.margin, stakes: a.stakes, prob });
        }
      }
    }
  }
  return res;
}

// Closing-line fair probability for a logged bet, from an event-odds response (same shape as one event).
export function closeFairFor(bet, evData, s) {
  const books = {};
  for (const b of evData.bookmakers || []) for (const m of b.markets || []) if (m.key === bet.mk) books[b.key] = normBook(b.key, m, s);
  const fair = fairFor(bet.sport, bet.mk, books, evData, s);
  if (!fair) return null;
  const pr = priceOutcome({ name: bet.name, desc: bet.desc, point: bet.point }, fair, bet.sport, bet.mk, evData);
  if (!pr || pr.p == null || pr.kind === 'bound') return { p: null, source: fair.source, fairPoint: pr?.fairPoint ?? null, note: 'line moved; not priceable' };
  return { p: pr.p, source: fair.source, kind: pr.kind, fairPoint: pr.fairPoint };
}

// Compact snapshot (sharp fair + user's books) for sparklines, steam, and proxy closes.
export function snapshotOf(an, s, t) {
  const mk = {};
  for (const [k, m] of Object.entries(an.markets)) {
    if (!MAIN_MARKETS.has(k)) continue;
    const fair = m.fair ? [...m.fair.pairs.values()].flatMap((p) => p.outcomes.map((o) => [o.name, o.desc, o.point, +o.p.toFixed(5)])) : [];
    const books = {};
    for (const bk of s.myBooks) if (m.books[bk]) books[bk] = m.books[bk].outcomes.map((o) => [o.name, o.desc, o.point, o.am]);
    mk[k] = { src: m.fair?.source ?? null, fair, books };
  }
  return { t, eventId: an.id, sport: an.sport, commence: an.commence, home: an.home, away: an.away, mk };
}
