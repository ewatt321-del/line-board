import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as M from '../js/math.js';
import { analyzeEvent, closeFairFor, arbsAndMiddles } from '../js/pricing.js';
import { DEFAULT_SETTINGS, isNYSchool } from '../js/config.js';
import { setRatings, resolveTeam, modelGame, modelProb } from '../js/ratings.js';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('odds conversions', () => {
  close(M.amToDec(-110), 1.909091);
  close(M.amToDec(150), 2.5);
  assert.equal(M.decToAm(2.5), 150);
  assert.equal(M.decToAm(1.5), -200);
});

test('de-vig 2-way', () => {
  const q = [1 / M.amToDec(-110), 1 / M.amToDec(-110)];
  const r = M.devig(q, 'power');
  close(r.p[0], 0.5); close(r.hold, 0.045455);
  const q2 = [1 / M.amToDec(-150), 1 / M.amToDec(130)];
  const mult = M.devigMult(q2), pow = M.devigPower(q2), shin = M.devigShin(q2);
  close(pow[0] + pow[1], 1); close(shin[0] + shin[1], 1);
  assert.ok(pow[0] > mult[0], 'power gives the favourite more than multiplicative');
  assert.ok(shin[0] > mult[0]);
});

test('de-vig 3-way (soccer 1X2)', () => {
  const q = [150, 240, 190].map((a) => 1 / M.amToDec(a));
  for (const m of ['power', 'shin', 'mult']) {
    const r = M.devig(q, m);
    close(r.p.reduce((s, x) => s + x, 0), 1);
    assert.equal(r.p.length, 3);
  }
});

test('EV and Kelly with caps', () => {
  close(M.ev(0.5, 2.0), 0); close(M.ev(0.52, 2.0), 0.04);
  const a = M.sizeBet({ p: 0.55, dec: 2.0, bankroll: 300, kellyMult: 0.25, maxBetPct: 0.02, dailyCapPct: 0.1 });
  close(a.kellyFull, 0.1); assert.equal(a.stake, 6); assert.equal(a.limitedBy, 'per-bet cap');
  const b = M.sizeBet({ p: 0.55, dec: 2.0, bankroll: 300, stakedToday: 28 });
  assert.equal(b.stake, 2); assert.equal(b.limitedBy, 'daily cap');
  const c = M.sizeBet({ p: 0.5, dec: 1.9, bankroll: 300 });
  assert.equal(c.stake, 0);
  const d = M.sizeBet({ p: 0.53, dec: M.amToDec(-105), bankroll: 300 });
  close(d.stake, Math.floor(300 * 0.25 * ((0.53 * M.amToDec(-105) - 1) / (M.amToDec(-105) - 1)) * 100) / 100, 0.011);
});

test('Kalshi fee', () => {
  assert.equal(M.kalshiFee(1, 0.5), 0.02);
  assert.equal(M.kalshiFee(100, 0.5), 1.75);
  close(M.kalshiEffDec(2.0), 1 / 0.5175);
  const o = M.kalshiOrder(10, 2.0);
  assert.ok(o.cost <= 10 && o.contracts === 19, JSON.stringify(o));
});

test('NFL key numbers come from real data and behave', () => {
  const at3 = M.nflSpreadAt({ x0: -3, p0: 0.5, x1: -2.5 });
  const at35 = M.nflSpreadAt({ x0: -3, p0: 0.5, x1: -3.5 });
  assert.ok(at3.p > 0.53 && at3.p < 0.58, `-2.5 from pk -3: ${at3.p}`);
  assert.ok(at35.p > 0.42 && at35.p < 0.47, `-3.5 from pk -3: ${at35.p}`);
  const h7 = M.nflSpreadAt({ x0: -7, p0: 0.5, x1: -6.5 }).p - 0.5;
  const h5 = M.nflSpreadAt({ x0: -5, p0: 0.5, x1: -4.5 }).p - 0.5;
  assert.ok(h7 > h5, 'half point through 7 worth more than through 5');
  close(M.nflSpreadAt({ x0: -3, p0: 0.52, x1: -3 }).p, 0.52);
  assert.ok(M.nflPushProb('spreads', -3, -3) > 0.07);
  const tot = M.nflTotalAt({ side: 'Over', L0: 44, p0: 0.5, L1: 43.5 });
  assert.ok(tot.p > 0.5 && tot.p < 0.56);
  assert.deepEqual(M.keyInfo('americanfootball_nfl', 'spreads', -3.5, -3), { on: 3, crosses: 3 });
});

test('NY college filter', () => {
  for (const t of ['Syracuse Orange', "St. John's Red Storm", 'St. John’s Red Storm', 'Army Black Knights', 'Buffalo Bulls', 'Manhattan Jaspers', 'Columbia Lions', 'Le Moyne Dolphins', 'LIU Sharks'])
    assert.ok(isNYSchool(t), t);
  for (const t of ['Buffalo Bills', 'Miami Hurricanes', 'Iowa State Cyclones', 'Ohio State Buckeyes', 'Syracuse'.slice(0, 3)]) assert.ok(!isNYSchool(t), t);
});

// Synthetic structure-only fixture (not real odds) to exercise the pipeline.
const S = { ...DEFAULT_SETTINGS };
const ev = (sport, books) => ({ id: 'e1', sport_key: sport, home_team: 'Home Team', away_team: 'Away Team', commence_time: '2026-11-20T00:00:00Z',
  bookmakers: Object.entries(books).map(([key, markets]) => ({ key, markets: Object.entries(markets).map(([k, outcomes]) => ({ key: k, last_update: '2026-11-14T00:00:00Z', outcomes })) })) });

test('pricing: exact line, key-number adjustment, Kalshi fee, 3-way', () => {
  const e = ev('americanfootball_nfl', {
    pinnacle: { spreads: [{ name: 'Home Team', price: -110, point: -3 }, { name: 'Away Team', price: -110, point: 3 }], h2h: [{ name: 'Home Team', price: -160 }, { name: 'Away Team', price: 140 }] },
    fanduel: { spreads: [{ name: 'Home Team', price: -110, point: -2.5 }, { name: 'Away Team', price: -110, point: 2.5 }], h2h: [{ name: 'Home Team', price: -150 }, { name: 'Away Team', price: 130 }] },
    kalshi: { h2h: [{ name: 'Home Team', price: -150 }, { name: 'Away Team', price: 145 }] },
  });
  const an = analyzeEvent(e, S);
  const home = an.rows.find((r) => r.mk === 'spreads' && r.name === 'Home Team');
  assert.equal(home.kind, 'keyadj'); assert.equal(home.book, 'fanduel');
  assert.ok(home.ev > 0.03, `-2.5 -110 vs fair -3 pk should be clearly +EV: ${home.ev}`);
  const away = an.rows.find((r) => r.mk === 'spreads' && r.name === 'Away Team');
  assert.ok(away.ev < 0);
  const ml = an.rows.find((r) => r.mk === 'h2h' && r.name === 'Home Team');
  const fair = M.devig([1 / M.amToDec(-160), 1 / M.amToDec(140)], 'power').p[0];
  close(ml.p, fair); assert.equal(ml.kind, 'exact');
  const mlAway = an.rows.find((r) => r.mk === 'h2h' && r.name === 'Away Team');
  assert.equal(mlAway.book, 'kalshi');
  close(mlAway.effDec, M.kalshiEffDec(M.amToDec(145)));

  const s = ev('soccer_epl', {
    pinnacle: { h2h: [{ name: 'Home Team', price: 120 }, { name: 'Away Team', price: 230 }, { name: 'Draw', price: 250 }] },
    fanduel: { h2h: [{ name: 'Home Team', price: 130 }, { name: 'Away Team', price: 210 }, { name: 'Draw', price: 240 }] },
  });
  const sa = analyzeEvent(s, S);
  const p = sa.markets.h2h.fair.pairs.get('ml').outcomes.reduce((x, o) => x + o.p, 0);
  close(p, 1);
  assert.equal(sa.rows.filter((r) => r.mk === 'h2h').length, 3);
});

test('pricing: consensus fallback when no sharp book, and lower bound in basketball', () => {
  const e = ev('basketball_nba', {
    draftkings: { spreads: [{ name: 'Home Team', price: -110, point: -5 }, { name: 'Away Team', price: -110, point: 5 }] },
    betmgm: { spreads: [{ name: 'Home Team', price: -112, point: -5 }, { name: 'Away Team', price: -108, point: 5 }] },
    fanduel: { spreads: [{ name: 'Home Team', price: -110, point: -4.5 }, { name: 'Away Team', price: -110, point: 4.5 }] },
  });
  const an = analyzeEvent(e, S);
  const home = an.rows.find((r) => r.mk === 'spreads' && r.name === 'Home Team');
  assert.match(home.fairSource, /Consensus/); assert.equal(home.kind, 'bound');
  const away = an.rows.find((r) => r.mk === 'spreads' && r.name === 'Away Team');
  assert.equal(away.kind, 'worse-line'); assert.equal(away.ev, null);
});

test('NY college game is blocked', () => {
  const e = { ...ev('basketball_ncaab', {}), home_team: "St. John's Red Storm" };
  assert.ok(analyzeEvent(e, S).nyBlocked);
});

test('CLV close pricing', () => {
  const close1 = ev('americanfootball_nfl', { pinnacle: { spreads: [{ name: 'Home Team', price: -130, point: -3 }, { name: 'Away Team', price: 110, point: 3 }] } });
  const bet = { sport: 'americanfootball_nfl', mk: 'spreads', name: 'Home Team', desc: null, point: -3 };
  const c = closeFairFor(bet, close1, S);
  assert.ok(c.p > 0.5 && c.kind === 'exact');
  const clv = M.amToDec(-110) * c.p - 1;
  assert.ok(clv > 0, 'bet -3 -110, closed -3 -130/+110: positive CLV');
});

test('arb finder', () => {
  const e = ev('basketball_nba', {
    fanduel: { h2h: [{ name: 'Home Team', price: 110 }, { name: 'Away Team', price: -130 }] },
    fanatics: { h2h: [{ name: 'Home Team', price: -140 }, { name: 'Away Team', price: 105 }] },
  });
  const an = analyzeEvent(e, S);
  const res = arbsAndMiddles(an, S);
  assert.ok(res.some((r) => r.type === 'arb' && r.margin > 0));
});

test('ratings: name matching and model probabilities', () => {
  const R = JSON.parse(fs.readFileSync(new URL('../data/ratings.json', import.meta.url)));
  setRatings(R);
  assert.equal(resolveTeam('americanfootball_ncaaf', 'Ohio State Buckeyes'), 'Ohio State');
  assert.equal(resolveTeam('americanfootball_ncaaf', 'Miami Hurricanes'), 'Miami');
  assert.equal(resolveTeam('americanfootball_ncaaf', 'Texas A&M Aggies'), 'Texas A&M');
  assert.equal(resolveTeam('americanfootball_nfl', 'Buffalo Bills'), 'Buffalo Bills');
  assert.equal(resolveTeam('soccer_epl', 'Brighton and Hove Albion'), 'Brighton and Hove Albion');
  assert.equal(resolveTeam('soccer_epl', 'Arsenal'), 'Arsenal');
  const g = modelGame('soccer_epl', 'Arsenal', 'Sunderland');
  close(g.pHome + g.pDraw + g.pAway, 1, 1e-3);
  assert.ok(g.pHome > g.pAway);
  const o = modelProb(g, 'soccer_epl', 'Arsenal', 'totals', 'Over', 2.5), u = modelProb(g, 'soccer_epl', 'Arsenal', 'totals', 'Under', 2.5);
  close(o + u, 1, 1e-6);
  const n = modelGame('americanfootball_nfl', 'Buffalo Bills', 'Miami Dolphins');
  const ph = modelProb(n, 'americanfootball_nfl', 'Buffalo Bills', 'spreads', 'Buffalo Bills', -n.margin);
  close(ph, 0.5, 1e-3);
});

test('consensus counts identical feeds once; robustness across de-vig methods', () => {
  const e = ev('americanfootball_nfl', {
    betrivers: { h2h: [{ name: 'Home Team', price: -1115 }, { name: 'Away Team', price: 650 }] },
    ballybet: { h2h: [{ name: 'Home Team', price: -1115 }, { name: 'Away Team', price: 650 }] },
    draftkings: { h2h: [{ name: 'Home Team', price: -1000 }, { name: 'Away Team', price: 650 }] },
    fanduel: { h2h: [{ name: 'Home Team', price: -1200 }, { name: 'Away Team', price: 750 }] },
    kalshi: { h2h: [{ name: 'Home Team', price: -733 }, { name: 'Away Team', price: 614 }] },
  });
  const an = analyzeEvent(e, S);
  const r = an.rows.find((x) => x.mk === 'h2h' && x.name === 'Home Team');
  assert.match(r.fairSource, /3 independent/);
  assert.equal(r.book, 'kalshi');
  assert.ok(r.evMin < r.ev, 'multiplicative de-vig gives the heavy favourite less');
  assert.equal(r.robust, false, 'heavy-favourite edge that depends on the de-vig method is not robust');
});
