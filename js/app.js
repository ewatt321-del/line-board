// Line Board UI. Everything runs in the browser; the API key never leaves it except to The Odds API.
import { amToDec, decToAm, fmtAm, sizeBet, devig, kalshiOrder, kalshiEffDec, meanCI, parlay, nflSpreadAt, nflTotalAt } from './math.js';
import { analyzeEvent, arbsAndMiddles, closeFairFor, snapshotOf } from './pricing.js';
import { SPORTS, SPORT_BY_KEY, BOOK_NAMES, NY_BOOKS, EXCHANGES, SHARP_REFS, MARKET_LABEL, DERIV_MARKETS, NEWS_LINKS,
  NEWS_FRESH_HOURS, NFL_STADIUMS, DEFAULT_SETTINGS, MAIN_MARKETS } from './config.js';
import * as api from './api.js';
import * as db from './store.js';
import { loadRatings, ratingsMeta, modelGame, modelProb } from './ratings.js';

// ---------------- state ----------------
const S = {
  settings: { ...DEFAULT_SETTINGS, ...db.lsGet('lb.settings', {}) },
  key: db.lsGet('lb.key', ''),
  tab: db.lsGet('lb.tab', 'best'),
  data: {},          // sport -> {events, fetchedAt}
  an: {},            // eventId -> analysis
  rows: [],
  bets: [],
  snaps: new Map(),  // eventId -> [snapshot...] sorted by t
  steam: [],
  weather: {},
  news: db.lsGet('lb.news', {}),
  sched: {},
  parlaySel: new Set(),
  busy: false,
  hiddenNY: {},
  models: new Map(),
  openGames: new Set(),
};
const saveSettings = () => db.lsSet('lb.settings', S.settings);

// ---------------- helpers ----------------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
const pctPlain = (x, d = 1) => (x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d) + '%');
const money = (x) => (x == null || !isFinite(x) ? '—' : (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2));
const bookName = (k) => BOOK_NAMES[k] || k;
const etDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etTime = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const stamp = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) : '—');
function until(iso) {
  const m = (new Date(iso) - Date.now()) / 60000;
  if (m < 0) return 'started';
  if (m < 60) return `in ${Math.round(m)}m`;
  if (m < 1440) return `in ${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
  return `in ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
function agoMin(ms) {
  if (ms == null) return '—';
  const m = (Date.now() - ms) / 60000;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, ms);
}
function selLabel(r) {
  const mk = r.mk;
  const pt = r.point != null ? (mk.includes('total') && !r.desc ? ` ${r.point}` : ` ${r.point > 0 ? '+' : ''}${r.point}`) : '';
  if (r.desc) return `${r.desc} ${r.name}${pt}`;
  if (mk.includes('total')) return `${r.name}${pt}`;
  return `${r.name}${pt}`;
}
const matchup = (o) => `${o.away} @ ${o.home}`;
const mkLabel = (mk) => MARKET_LABEL[mk] || mk;

// ---------------- bankroll ----------------
function settledPnl() { return S.bets.reduce((s, b) => s + (b.pnl || 0), 0); }
function curBankroll() { return S.settings.bankrollMode === 'fixed' ? S.settings.bankroll : S.settings.bankroll + settledPnl(); }
function stakedToday() { const d = etDate(Date.now()); return S.bets.filter((b) => etDate(b.ts) === d && b.result !== 'void').reduce((s, b) => s + b.stake, 0); }
function openExposure() { return S.bets.filter((b) => !b.result).reduce((s, b) => s + b.stake, 0); }

// ---------------- model (second opinion) ----------------
function modelFor(an) {
  if (!S.models.has(an.id)) {
    let g = null;
    try { g = modelGame(an.sport, an.home, an.away); } catch (e) { console.warn('model error', an.home, an.away, e); }
    S.models.set(an.id, g);
  }
  return S.models.get(an.id);
}
function modelOnRow(r) {
  if (!MAIN_MARKETS.has(r.mk)) return null;
  const g = modelFor(S.an[r.eventId]);
  if (!g || g.missing) return g?.missing ? { missing: true } : null;
  const pt = r.point ?? r.fairPoint;
  const pm = modelProb(g, r.sport, r.home, r.mk, r.name, pt);
  if (pm == null || r.p == null) return pm == null ? null : { pm, diff: null, low: g.low };
  return { pm, diff: pm - r.p, low: g.low, nMin: g.nMin, stale: g.stale };
}
function modelPick(an, rows) {
  const g = modelFor(an);
  if (!g) return null;
  if (g.missing) return { text: `Model: no rating for ${g.missing.join(', ')}`, cls: '' };
  let best = null;
  for (const r of rows) {
    if (!MAIN_MARKETS.has(r.mk) || r.fairP == null) continue;
    const pm = modelProb(g, r.sport, r.home, r.mk, r.name, r.fairPoint);
    if (pm == null) continue;
    const d = pm - r.fairP;
    if (!best || d > best.d) best = { r, pm, d };
  }
  const head = g.type === 'dc'
    ? `xG ${g.xgHome.toFixed(2)}–${g.xgAway.toFixed(2)} · H ${pctPlain(g.pHome, 0)} D ${pctPlain(g.pDraw, 0)} A ${pctPlain(g.pAway, 0)}`
    : `proj ${an.home.split(' ').slice(-1)[0]} ${g.margin >= 0 ? '−' : '+'}${Math.abs(g.margin).toFixed(1)}, total ${g.total.toFixed(1)}`;
  const low = g.low ? ' · small sample' : '';
  if (g.nMin < S.settings.modelPickMinGames) return { text: `Model: ${head} — a team has under ${S.settings.modelPickMinGames} games this season; no picks yet`, cls: '' };
  if (!best || best.d < 0.03) return { text: `Model: ${head} — no strong lean vs market${low}`, cls: '' };
  const r = best.r;
  const sel = selLabel({ ...r, point: r.fairPoint });
  if (best.d >= S.settings.modelPickPp / 100) return { text: `MODEL PICK: ${sel} (${mkLabel(r.mk)}) — model ${pctPlain(best.pm, 0)} vs market ${pctPlain(r.fairP, 0)} · ${head}`, cls: 'violet' };
  return { text: `Model lean: ${sel} (${mkLabel(r.mk)}) — model ${pctPlain(best.pm, 0)} vs market ${pctPlain(r.fairP, 0)}, below the ${S.settings.modelPickPp}-pt pick line · ${head}`, cls: '' };
}

// ---------------- news / weather / schedule flags ----------------
function newsState(an) {
  const t = S.news[an.id];
  const fresh = (NEWS_FRESH_HOURS[an.sport] || 3) * 3600e3;
  if (t && Date.now() - t < fresh) return { ok: true, t };
  return { ok: false, t };
}
function b2b(an) {
  if (an.sport !== 'basketball_nba') return null;
  const d = etDate(an.commence);
  const prev = etDate(new Date(an.commence).getTime() - 864e5), next = etDate(new Date(an.commence).getTime() + 864e5);
  const out = [];
  for (const team of [an.home, an.away]) {
    const games = Object.values(S.sched.basketball_nba || {}).filter((g) => g.home === team || g.away === team);
    const short = team.split(' ').slice(-1)[0];
    if (games.some((g) => etDate(g.commence) === prev)) out.push(`${short} 2nd night of B2B`);
    else if (games.some((g) => etDate(g.commence) === next && etDate(g.commence) !== d)) out.push(`${short} B2B tomorrow`);
  }
  return out.length ? out : null;
}
function shortWeek(an) {
  if (an.sport !== 'americanfootball_nfl') return null;
  const day = new Date(an.commence).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  return day === 'Thu' ? 'Thursday game: short week likely' : null;
}
async function loadWeather(ans) {
  const jobs = [];
  for (const an of ans) {
    if (an.sport !== 'americanfootball_nfl') continue;
    const st = NFL_STADIUMS[an.home];
    if (!st || st.roof !== 'open') continue;
    const hrs = (new Date(an.commence) - Date.now()) / 3600e3;
    if (hrs < -3 || hrs > 24 * 14) continue;
    const c = S.weather[an.id];
    if (c && Date.now() - c.at < 3600e3) continue;
    jobs.push((async () => {
      try {
        const u = `https://api.open-meteo.com/v1/forecast?latitude=${st.lat}&longitude=${st.lon}&hourly=wind_speed_10m,wind_gusts_10m,precipitation_probability,temperature_2m&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=GMT&forecast_days=16`;
        const j = await (await fetch(u)).json();
        const target = new Date(an.commence).toISOString().slice(0, 13);
        const i = j.hourly.time.findIndex((t) => t.startsWith(target));
        if (i < 0) return;
        S.weather[an.id] = { at: Date.now(), wind: j.hourly.wind_speed_10m[i], gust: j.hourly.wind_gusts_10m[i], temp: j.hourly.temperature_2m[i], precip: j.hourly.precipitation_probability[i] };
      } catch { /* weather is optional */ }
    })());
  }
  await Promise.all(jobs);
}
function weatherChip(an) {
  if (an.sport !== 'americanfootball_nfl') return null;
  const st = NFL_STADIUMS[an.home];
  if (!st) return null;
  if (st.roof !== 'open') return { text: st.roof === 'dome' ? 'Indoors' : 'Retractable roof', cls: '' };
  const w = S.weather[an.id];
  if (!w) return { text: 'Weather: not loaded', cls: '' };
  const txt = `Wind ${Math.round(w.wind)} mph (gusts ${Math.round(w.gust)}) · ${Math.round(w.temp)}°F · rain ${w.precip ?? '—'}%`;
  return { text: w.wind >= 15 ? `${txt} — wind lowers totals` : txt, cls: w.wind >= 15 ? 'amber' : '', title: 'Forecast at the home stadium. Wrong for neutral-site/international games.' };
}

// ---------------- analysis ----------------
function sparkSeries(r) {
  const snaps = S.snaps.get(r.eventId) || [];
  const pts = [];
  for (const sn of snaps) {
    const m = sn.mk?.[r.mk];
    const f = m?.fair?.find((x) => x[0] === r.name && (x[1] || null) === (r.desc || null));
    if (!f) continue;
    pts.push({ t: sn.t, v: r.mk === 'h2h' ? f[3] : f[2], p: f[3] });
  }
  return pts;
}
function spark(pts, mk) {
  if (pts.length < 2) return '<span class="muted small">line history builds as you refresh</span>';
  const w = 90, h = 22;
  const vs = pts.map((p) => p.v), lo = Math.min(...vs), hi = Math.max(...vs);
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const xy = pts.map((p) => [((p.t - t0) / Math.max(1, t1 - t0)) * (w - 2) + 1, hi === lo ? h / 2 : h - 2 - ((p.v - lo) / (hi - lo)) * (h - 4)]);
  const first = pts[0], last = pts[pts.length - 1];
  const fmt = (p) => (mk === 'h2h' ? fmtAm(decToAm(1 / p.v)) : (p.v > 0 && !mk.includes('total') ? '+' : '') + p.v);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="#6aa7ff" stroke-width="1.5" points="${xy.map((x) => x.join(',')).join(' ')}"/></svg>
    <span class="small muted" title="Sharp fair line from the first time this page saw the game (not the true open)">${fmt(first)} → ${fmt(last)}</span>`;
}

function recompute() {
  S.an = {}; S.rows = []; S.hiddenNY = {}; S.models.clear();
  const s = S.settings;
  const bank = curBankroll(), today = stakedToday();
  for (const sp of SPORTS) {
    const d = S.data[sp.key];
    if (!d || !s.sports.includes(sp.key)) continue;
    for (const ev of d.events) {
      if (new Date(ev.commence_time) < Date.now() - 4 * 3600e3) continue;
      const an = analyzeEvent(ev, s);
      an.fetchedAt = d.fetchedAt;
      if (an.nyBlocked) { (S.hiddenNY[sp.key] ||= []).push(`${ev.away_team} @ ${ev.home_team}`); continue; }
      S.an[an.id] = an;
      for (const r of an.rows) {
        r.ageMin = (Date.now() - d.fetchedAt) / 60000;
        r.stale = r.ageMin > s.staleMin;
        r.started = new Date(r.commence) <= Date.now();
        if (r.p != null && r.effDec) {
          r.size = sizeBet({ p: r.p, dec: r.effDec, bankroll: bank, kellyMult: s.kellyMult, maxBetPct: s.maxBetPct, dailyCapPct: s.dailyCapPct, stakedToday: today, minStake: s.minStake });
        }
        try { r.model = modelOnRow(r); } catch (e) { r.model = null; console.warn('model row error', e); }
        r.modelPick = !!(r.model?.diff != null && r.model.diff >= s.modelPickPp / 100 && (r.model.nMin ?? 0) >= s.modelPickMinGames
          && r.book && r.p != null && r.effDec && MAIN_MARKETS.has(r.mk));
        if (r.modelPick) {
          // Size on a 50/50 blend of model and market, with its own (smaller) per-bet cap.
          const pb = (r.model.pm + r.p) / 2;
          r.mSize = sizeBet({ p: pb, dec: r.effDec, bankroll: bank, kellyMult: s.kellyMult, maxBetPct: s.modelPickMaxPct, dailyCapPct: s.dailyCapPct, stakedToday: today, minStake: s.minStake });
        }
        S.rows.push(r);
      }
    }
  }
}

// ---------------- snapshots / steam / closes ----------------
async function loadSnaps() {
  await db.pruneSnaps(Date.now() - 10 * 864e5);
  const all = await db.getAll('snaps');
  S.snaps.clear();
  for (const sn of all) { if (!S.snaps.has(sn.eventId)) S.snaps.set(sn.eventId, []); S.snaps.get(sn.eventId).push(sn); }
  for (const arr of S.snaps.values()) arr.sort((a, b) => a.t - b.t);
}
function detectSteam(prev, cur) {
  const out = [];
  if (!prev) return out;
  for (const [mk, m] of Object.entries(cur.mk)) {
    const pm = prev.mk?.[mk];
    if (!pm || !m.src || m.src !== pm.src || m.src.startsWith('Consensus')) continue;
    for (const f of m.fair) {
      const pf = pm.fair.find((x) => x[0] === f[0] && x[1] === f[1]);
      if (!pf) continue;
      const moved = pf[2] !== f[2] || Math.abs(pf[3] - f[3]) >= S.settings.steamPp / 100;
      if (!moved) continue;
      for (const [bk, outs] of Object.entries(m.books)) {
        const o = outs.find((x) => x[0] === f[0] && x[1] === f[1]);
        const po = pm.books?.[bk]?.find((x) => x[0] === f[0] && x[1] === f[1]);
        if (o && po && o[2] === po[2] && o[3] === po[3]) {
          out.push({ eventId: cur.eventId, sport: cur.sport, home: cur.home, away: cur.away, mk, name: f[0], desc: f[1], bk,
            from: { point: pf[2], p: pf[3] }, to: { point: f[2], p: f[3] }, book: { point: o[2], am: o[3] }, t: cur.t });
        }
      }
    }
  }
  return out;
}
function proxyClose(bet) {
  const snaps = (S.snaps.get(bet.eventId) || []).filter((s) => s.t <= new Date(bet.commence).getTime());
  for (let i = snaps.length - 1; i >= 0; i--) {
    const m = snaps[i].mk?.[bet.mk];
    if (!m?.fair?.length) continue;
    const same = m.fair.find((x) => x[0] === bet.name && (x[1] || null) === (bet.desc || null) && x[2] === bet.point);
    let p = same ? same[3] : null, kind = 'proxy';
    if (p == null && bet.sport === 'americanfootball_nfl' && bet.point != null) {
      const f = m.fair.find((x) => x[0] === bet.name && (x[1] || null) === (bet.desc || null));
      if (f && bet.mk === 'spreads') p = nflSpreadAt({ x0: f[2], p0: f[3], x1: bet.point }).p;
      if (f && bet.mk === 'totals') p = nflTotalAt({ side: bet.name, L0: f[2], p0: f[3], L1: bet.point }).p;
    }
    if (p == null) continue;
    return { p, source: m.src, kind, t: snaps[i].t, minsBefore: Math.round((new Date(bet.commence) - snaps[i].t) / 60000) };
  }
  return null;
}
function applyClose(bet, c) {
  bet.close = c;
  bet.clv = c?.p != null ? bet.effDec * c.p - 1 : null;
}
async function closesFromFresh(sportKey) {
  const evs = S.data[sportKey]?.events || [];
  const changed = [];
  for (const b of S.bets) {
    if (b.sport !== sportKey || b.result || (b.close && b.close.kind !== 'proxy')) continue;
    const ev = evs.find((e) => e.id === b.eventId);
    if (!ev) continue;
    const mins = (new Date(ev.commence_time) - Date.now()) / 60000;
    if (mins > S.settings.closeWindowMin || mins < -2) continue;
    const c = closeFairFor(b, ev, S.settings);
    if (c?.p != null) { applyClose(b, { ...c, kind: 'auto', t: Date.now(), minsBefore: Math.round(mins) }); changed.push(b); }
  }
  if (changed.length) await db.putMany('bets', changed);
}
async function fillProxyCloses() {
  const changed = [];
  for (const b of S.bets) {
    if (b.close || new Date(b.commence) > Date.now()) continue;
    const c = proxyClose(b);
    if (c) { applyClose(b, c); changed.push(b); }
  }
  if (changed.length) await db.putMany('bets', changed);
}
let closeLoopBusy = false;
async function closeLoop() {
  if (closeLoopBusy || !S.key) return;
  closeLoopBusy = true;
  try {
    const due = S.bets.filter((b) => {
      if (b.result || (b.close && b.close.kind !== 'proxy')) return false;
      const mins = (new Date(b.commence) - Date.now()) / 60000;
      return mins <= S.settings.closeWindowMin && mins > -1;
    });
    const byEv = new Map();
    for (const b of due) { if (!byEv.has(b.eventId)) byEv.set(b.eventId, []); byEv.get(b.eventId).push(b); }
    for (const [eid, bets] of byEv) {
      const mks = [...new Set(bets.map((b) => b.mk))];
      try {
        const { data } = await api.eventOdds(S.key, bets[0].sport, eid, mks, S.settings.fetchBooks);
        for (const b of bets) {
          const c = closeFairFor(b, data, S.settings);
          const mins = Math.round((new Date(b.commence) - Date.now()) / 60000);
          if (c?.p != null) applyClose(b, { ...c, kind: 'auto', t: Date.now(), minsBefore: mins });
        }
        await db.putMany('bets', bets);
        toast(`Closing line captured for ${bets.length} bet(s) (${mks.length} credit${mks.length > 1 ? 's' : ''})`);
      } catch (e) { toast(`Close capture failed: ${e.message}`); }
    }
    if (S.settings.historicalCloses) {
      const need = S.bets.filter((b) => !b.result && (!b.close || b.close.kind === 'proxy') && new Date(b.commence) < Date.now() - 5 * 60e3 && !b.histTried);
      for (const b of need.slice(0, 5)) {
        b.histTried = true;
        try {
          const when = new Date(new Date(b.commence).getTime() - 60e3).toISOString().replace(/\.\d+Z$/, 'Z');
          const { data } = await api.historicalEventOdds(S.key, b.sport, b.eventId, when, [b.mk], S.settings.fetchBooks);
          const c = closeFairFor(b, data.data || data, S.settings);
          if (c?.p != null) applyClose(b, { ...c, kind: 'historical', t: Date.now(), minsBefore: 1 });
        } catch (e) { toast(`Historical close failed: ${e.message}`); }
        await db.put('bets', b);
      }
    }
  } finally { closeLoopBusy = false; }
}

// ---------------- refresh ----------------
function refreshCost(keys) { return keys.reduce((s, k) => s + api.costOdds(SPORT_BY_KEY[k].markets, S.settings.fetchBooks), 0); }
async function refresh(keys, { auto = false } = {}) {
  if (S.busy) return;
  if (!S.key) { toast('Add your Odds API key in Settings first.'); setTab('settings'); return; }
  const cost = refreshCost(keys);
  const c = api.creditState();
  if (!auto && c.remaining != null && c.remaining < cost) { toast(`Not enough credits: need ${cost}, have ${c.remaining}.`); return; }
  if (!auto && c.remaining != null && c.remaining - cost < 50 && !confirm(`This uses ${cost} credits and leaves ${c.remaining - cost}. Continue?`)) return;
  S.busy = true; renderControls();
  const newSteam = [];
  try {
    for (const k of keys) {
      try {
        const { data } = await api.odds(S.key, k, SPORT_BY_KEY[k].markets, S.settings.fetchBooks);
        const fetchedAt = Date.now();
        S.data[k] = { events: data, fetchedAt };
        await db.kvSet(`odds:${k}`, S.data[k]);
        // schedule (for back-to-backs)
        const sch = S.sched[k] || {};
        for (const ev of data) sch[ev.id] = { home: ev.home_team, away: ev.away_team, commence: ev.commence_time };
        for (const [id, g] of Object.entries(sch)) if (new Date(g.commence) < Date.now() - 4 * 864e5) delete sch[id];
        S.sched[k] = sch; await db.kvSet(`sched:${k}`, sch);
        // snapshots + steam
        const snaps = [];
        for (const ev of data) {
          const an = analyzeEvent(ev, S.settings);
          if (an.nyBlocked) continue;
          const sn = snapshotOf(an, S.settings, fetchedAt);
          const prevArr = S.snaps.get(ev.id) || [];
          newSteam.push(...detectSteam(prevArr[prevArr.length - 1], sn));
          prevArr.push(sn); S.snaps.set(ev.id, prevArr);
          snaps.push(sn);
        }
        await db.putMany('snaps', snaps);
        await closesFromFresh(k);
      } catch (e) { toast(`${SPORT_BY_KEY[k].short}: ${e.message}`, 6000); }
    }
    S.steam = newSteam;
    db.lsSet('lb.lastRefresh', Date.now());
    recompute();
    await loadWeather(Object.values(S.an));
    await fillProxyCloses();
  } finally { S.busy = false; render(); }
}

let autoTimer = null;
function scheduleAuto() {
  clearInterval(autoTimer);
  if (!S.settings.autoRefresh) return;
  autoTimer = setInterval(() => {
    const c = api.creditState();
    const keys = S.settings.sports;
    const cost = refreshCost(keys);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const usedToday = c.day === today ? c.dayUsed : 0;
    if (usedToday + cost > S.settings.autoDailyCredits) return;
    if (document.hidden) return;
    refresh(keys, { auto: true });
  }, Math.max(10, S.settings.autoRefreshMin) * 60e3);
}

// ---------------- rendering ----------------
function renderTop() {
  const settled = S.bets.filter((b) => b.result && b.result !== 'void');
  const staked = settled.reduce((s, b) => s + b.stake, 0);
  const pnl = settledPnl();
  const clvs = S.bets.filter((b) => b.clv != null).map((b) => b.clv);
  const avgClv = clvs.length ? clvs.reduce((s, x) => s + x, 0) / clvs.length : null;
  const c = api.creditState();
  const last = db.lsGet('lb.lastRefresh', null);
  const stat = (v, l, cls = '') => `<div class="stat"><b class="${cls}">${v}</b><span>${l}</span></div>`;
  $('#top').innerHTML = [
    stat(money(curBankroll()), 'Bankroll'),
    stat(money(openExposure()), 'Open exposure'),
    stat(avgClv == null ? '—' : pct(avgClv, 2), `Avg CLV (${clvs.length})`, avgClv == null ? '' : avgClv >= 0 ? 'pos' : 'neg'),
    stat(staked ? pct(pnl / staked) : '—', 'ROI', pnl >= 0 ? 'pos' : 'neg'),
    stat(S.bets.length, 'Bets logged'),
    stat(c.remaining ?? '—', `API credits left${c.at ? ' · ' + agoMin(new Date(c.at).getTime()) : ''}`, c.remaining != null && c.remaining < 60 ? 'neg' : ''),
    stat(last ? stamp(new Date(last).toISOString()) : '—', `Last refresh${last ? ' · ' + agoMin(last) : ''}`),
  ].join('');
}

const TABS = () => [['best', 'Suggested Bets'], ...SPORTS.filter((s) => S.settings.sports.includes(s.key)).map((s) => [s.key, s.short]),
  ['parlays', 'Parlays'], ...(S.settings.showArbs ? [['arbs', 'Middles/Arbs']] : []), ['log', 'Bet Log'], ['results', 'Results'], ['settings', 'Settings']];
function renderTabs() {
  $('#tabs').innerHTML = TABS().map(([k, l]) => `<button data-act="tab" data-k="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('');
}
function renderControls() {
  const keys = S.settings.sports;
  const c = api.creditState();
  const now = new Date();
  const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;
  const perDay = c.remaining != null ? Math.floor(c.remaining / daysLeft) : null;
  const sportBtns = SPORTS.filter((s) => keys.includes(s.key)).map((s) => {
    const d = S.data[s.key];
    return `<button data-act="refresh" data-k="${s.key}" ${S.busy ? 'disabled' : ''} title="Last: ${d ? agoMin(d.fetchedAt) : 'never'}">↻ ${s.short} <span class="muted">${refreshCost([s.key])}cr</span></button>`;
  }).join('');
  $('#controls').innerHTML = `${sportBtns}<button data-act="refresh-all" ${S.busy ? 'disabled' : ''}>↻ All <span class="muted">${refreshCost(keys)}cr</span></button>
    ${S.busy ? '<span class="muted small">Refreshing…</span>' : ''}
    <span class="budget">${perDay != null ? `~${perDay} credits/day left this month` : 'Credits unknown until first call'}${S.settings.autoRefresh ? ` · auto every ${S.settings.autoRefreshMin}m (cap ${S.settings.autoDailyCredits}/day)` : ' · manual refresh only'}</span>`;
}

function chipsFor(r, an) {
  const ch = [];
  if (r.flags.bias) ch.push(`<span class="chip red" title="Fan bias check">CHARGERS — bias check</span>`);
  if (r.flags.verify) ch.push(`<span class="chip red">VERIFY: probably stale or an error</span>`);
  if (r.stale) ch.push(`<span class="chip amber">Stale: pulled ${Math.round(r.ageMin)}m ago</span>`);
  if (r.flags.key) {
    const k = r.flags.key;
    if (k.crosses != null && r.fairPoint !== r.point) ch.push(`<span class="chip blue">Crosses key ${k.crosses}</span>`);
    else if (k.on != null) ch.push(`<span class="chip blue">Key # ${k.on}</span>`);
  }
  if (r.kind === 'keyadj') ch.push(`<span class="chip blue" title="Fair price moved from ${r.fairPoint} to ${r.point} using historical NFL margins">Key-number priced</span>`);
  if (r.kind === 'bound') ch.push(`<span class="chip" title="Your line is better than the reference line; EV shown is a floor">EV is a floor (better line)</span>`);
  if (r.push != null && r.push > 0.02) ch.push(`<span class="chip">Push ${pctPlain(r.push)}</span>`);
  if (!r.sharp && r.fairSource) ch.push(`<span class="chip amber" title="${esc(r.fairMethod)}">No sharp book — consensus fair</span>`);
  if (r.flags.kalshi) ch.push(`<span class="chip" title="Kalshi taker fee included in EV. Confirm the live ask on Kalshi before buying.">Kalshi: fee incl. · confirm ask</span>`);
  if (r.weakFair) ch.push(`<span class="chip amber">Weak fair price: under ${S.settings.minConsensusBooks} independent books</span>`);
  if (r.evMin != null && !r.robust) ch.push(`<span class="chip amber" title="EV under power/Shin/multiplicative de-vig">Method-sensitive: EV ${pct(r.evMin)} to ${pct(r.evMax)}</span>`);
  if (r.flags.limited) ch.push(`<span class="chip amber">Limited book</span>`);
  if (!r.main) ch.push(`<span class="chip" title="Lower limits and noisier fair prices">Derivative market</span>`);
  const ns = newsState(an);
  ch.push(ns.ok ? `<span class="chip green">News checked ${agoMin(ns.t)}</span>` : `<span class="chip amber">Check news</span>`);
  const w = weatherChip(an); if (w) ch.push(`<span class="chip ${w.cls}" title="${esc(w.title || '')}">${esc(w.text)}</span>`);
  const bb = b2b(an); if (bb) bb.forEach((x) => ch.push(`<span class="chip amber">${esc(x)}</span>`));
  const sw = shortWeek(an); if (sw) ch.push(`<span class="chip">${sw}</span>`);
  if (r.sport === 'basketball_ncaab' && new Date(r.commence) < new Date(new Date(r.commence).getFullYear(), 11, 15)) ch.push(`<span class="chip">Early season: noisy for books too</span>`);
  if (r.model?.missing) ch.push(`<span class="chip">Model: team not rated</span>`);
  else if (r.model?.diff != null) {
    const d = r.model.diff;
    ch.push(`<span class="chip ${d >= 0.02 ? 'violet' : d <= -0.02 ? 'amber' : ''}" title="Second opinion only. Market wins ties.">Model ${pctPlain(r.model.pm, 0)} (${d >= 0 ? 'agrees' : 'disagrees'} ${pct(d, 0).replace('%', 'pp')})${r.model.low ? ' · small sample' : ''}</span>`);
  }
  return ch.join('');
}

function rowCard(r, { compact = false, mode = 'price' } = {}) {
  const an = S.an[r.eventId];
  const isModel = mode === 'model';
  const hot = isModel || (r.ev != null && r.ev >= r.threshold && !r.flags.verify);
  const sz = isModel ? r.mSize : r.size;
  const stakeTxt = sz ? (sz.stake > 0 ? `${money(sz.stake)}${sz.limitedBy ? ` <span class="muted small">(${sz.limitedBy})</span>` : ''}${sz.belowMin ? ' <span class="muted small">(below min)</span>' : ''}` : '$0') : '—';
  const fairAm = r.p != null ? fmtAm(decToAm(1 / r.p)) : '—';
  const fairLine = r.fairPoint != null && r.fairPoint !== r.point ? ` at ${r.fairPoint > 0 && !r.mk.includes('total') ? '+' : ''}${r.fairPoint}` : '';
  return `<div class="card ${hot ? 'hot' : ''} ${r.flags.verify ? 'warn' : ''} ${r.flags.bias ? 'bias' : ''}">
    <div class="row1"><span>${SPORT_BY_KEY[r.sport].short} · ${esc(matchup(r))}</span><span>${etTime(r.commence)} · ${until(r.commence)}</span></div>
    <div class="row2"><span class="pick">${isModel ? '<span class="chip violet">MODEL PICK</span> ' : ''}${esc(mkLabel(r.mk))}: ${esc(selLabel(r))}</span>
      ${isModel ? `<span class="ev pos" title="Model probability minus market fair probability">+${(r.model.diff * 100).toFixed(0)} pts</span>`
        : `<span class="ev ${r.ev == null ? 'muted' : r.ev >= 0 ? 'pos' : 'neg'}">${r.kind === 'bound' && r.ev != null ? '≥' : ''}${pct(r.ev)}</span>`}</div>
    ${isModel ? `<div class="row3">Model <b>${pctPlain(r.model.pm)}</b> vs market <b>${pctPlain(r.p)}</b> · EV if the market is right: <b class="${r.ev >= 0 ? 'pos' : 'neg'}">${pct(r.ev)}</b> · EV if the model is right: <b class="pos">${pct(r.model.pm * r.effDec - 1)}</b></div>` : ''}
    <div class="row3"><span>Best: <b class="price">${r.am != null ? fmtAm(r.am) : '—'}</b> @ ${r.book ? esc(bookName(r.book)) : '<span class="muted">none of your books</span>'}</span>
      <span class="muted">· Fair <span class="price">${r.kind === 'keyadj' ? fmtAm(decToAm(1 / r.p)) : fairAm}</span>${r.kind === 'keyadj' ? '' : esc(fairLine)} (${esc(r.fairSource || 'no fair price')})</span>
      <span>· Stake <b>${stakeTxt}</b></span></div>
    <div class="row3">${spark(sparkSeries(r), r.mk)} <span class="muted small">· ${esc(bookName(r.book || ''))} updated ${stamp(r.lastUpdate)} · pulled ${Math.round(r.ageMin)}m ago</span></div>
    ${isModel && r.alsoPicks?.length ? `<div class="row3 muted small">Model also likes: ${r.alsoPicks.map((x) => `${esc(mkLabel(x.mk))} ${esc(selLabel(x))} (+${(x.model.diff * 100).toFixed(0)})`).join(', ')} — same opinion, don't stack them.</div>` : ''}
    <div class="chips">${chipsFor(r, an)}</div>
    ${compact ? '' : `<div class="actions">${r.book && r.p != null && !r.started ? `<button class="primary" data-act="bet" data-src="${mode}" data-id="${esc(r.id)}">I bet this</button>` : ''}
      <button data-act="details" data-id="${esc(r.id)}">Details</button>
      <button data-act="news" data-id="${esc(r.eventId)}">${newsState(an).ok ? 'News ✓' : 'Mark news checked'}</button></div>`}
  </div>`;
}

function steamPanel(filterSport) {
  const list = S.steam.filter((x) => !filterSport || x.sport === filterSport);
  if (!list.length) return '';
  return `<div class="alert"><b>Steam:</b> sharp line moved since your last refresh but your book hasn't.<br>${list.slice(0, 12).map((x) => {
    const p = (o) => `${o.point != null ? (o.point > 0 && !x.mk.includes('total') ? '+' : '') + o.point + ' ' : ''}${pctPlain(o.p)}`;
    return `${SPORT_BY_KEY[x.sport].short} ${esc(x.away)} @ ${esc(x.home)} — ${esc(mkLabel(x.mk))} ${esc(x.name)}: sharp ${p(x.from)} → ${p(x.to)}; ${esc(bookName(x.bk))} still ${x.book.point ?? ''} ${fmtAm(x.book.am)}`;
  }).join('<br>')}</div>`;
}

function renderBest() {
  // One model pick per game: moneyline, spread and total on the same game are the same opinion, not three bets.
  const allPicks = S.rows.filter((r) => r.modelPick && !r.started).sort((a, b) => b.model.diff - a.model.diff);
  const byGame = new Map();
  for (const r of allPicks) { if (!byGame.has(r.eventId)) byGame.set(r.eventId, { top: r, also: [] }); else byGame.get(r.eventId).also.push(r); }
  const picks = [...byGame.values()].map((x) => Object.assign(x.top, { alsoPicks: x.also }));
  const cand = S.rows.filter((r) => r.book && r.ev != null && r.ev >= r.threshold && !r.started);
  const rows = cand.filter((r) => !r.weakFair && (!S.settings.requireRobust || r.robust)).sort((a, b) => b.ev - a.ev);
  const held = cand.length - rows.length;
  const anyData = Object.keys(S.data).length;
  let h = steamPanel();
  if (!S.key) h += `<div class="note">Add your Odds API key in <a href="#" data-act="tab" data-k="settings">Settings</a>, then tap a refresh button. Nothing is fetched automatically.</div>`;
  else if (!anyData) h += `<div class="note">No odds loaded yet. Tap ↻ for a sport — each tap shows its credit cost.</div>`;
  h += `<div class="section-title">Price edges (${rows.length}) — your book beats the market</div>`;
  h += `<div class="note">Your book pays more than the sharp market's no-vig price, after Kalshi fees. Main markets ≥ ${pctPlain(S.settings.evMain)}, derivatives ≥ ${pctPlain(S.settings.evDeriv)}; above ${pctPlain(S.settings.evVerify, 0)} = verify first. This is the proven long-run edge.</div>`;
  if (held) h += `<div class="note">${held} more price(s) clear the threshold but were held back: the fair price came from fewer than ${S.settings.minConsensusBooks} independent books, or the edge disappears under another de-vig method. They're still visible in the sport tabs with a flag.</div>`;
  if (anyData && !rows.length) h += `<div class="note">No bets clear the thresholds right now. That's normal: most of the time the books are priced right. Refresh closer to game time or after news.</div>`;
  h += rows.map((r) => rowCard(r)).join('');
  h += `<div class="section-title">Model picks (${picks.length}) — model beats the market by ${S.settings.modelPickPp}+ pts</div>`;
  h += `<div class="note">The model's probability is at least ${S.settings.modelPickPp} points above the market's. Unproven: the model knows nothing about injuries or lineups, so check news first. Stakes use a 50/50 blend of model and market, capped at ${pctPlain(S.settings.modelPickMaxPct, 0)} of bankroll. One pick per game. Logged separately so Results can show whether these beat the close.</div>`;
  if (anyData && !picks.length) h += `<div class="note">No model picks right now.</div>`;
  h += picks.map((r) => rowCard(r, { mode: 'model' })).join('');
  $('#main').innerHTML = h;
}

function renderSport(key) {
  const sp = SPORT_BY_KEY[key];
  const d = S.data[key];
  let h = steamPanel(key);
  if (!d) { $('#main').innerHTML = h + `<div class="note">No ${sp.short} odds loaded. Tap ↻ ${sp.short} (${refreshCost([key])} credits).</div>`; return; }
  const meta = ratingsMeta()?.sports?.[key];
  h += `<div class="note">Pulled ${agoMin(d.fetchedAt)}. ${meta ? `Model ratings updated ${agoMin(new Date(meta.updated).getTime())} (${esc(meta.source)}, ${meta.games} games)${meta.stale ? ' — STALE' : ''}.` : 'Model ratings not available for this sport yet.'}
    ${(NEWS_LINKS[key] || []).map(([l, u]) => `<a href="${u}" target="_blank" rel="noopener">${l}</a>`).join(' · ')}</div>`;
  const ans = Object.values(S.an).filter((a) => a.sport === key).sort((a, b) => new Date(a.commence) - new Date(b.commence));
  for (const an of ans) {
    const rows = an.rows.filter((r) => MAIN_MARKETS.has(r.mk) || r.book);
    const best = rows.filter((r) => r.ev != null).sort((a, b) => b.ev - a.ev)[0];
    const mp = modelPick(an, rows);
    const bias = rows[0]?.flags.bias;
    h += `<details data-eid="${esc(an.id)}" ${S.openGames.has(an.id) ? 'open' : ''} class="card game ${best && best.ev >= best.threshold ? 'hot' : ''} ${bias ? 'bias' : ''}"><summary>
      <span><span class="t">${esc(matchup(an))}</span><br><span class="muted small">${etTime(an.commence)} · ${until(an.commence)}</span></span>
      <span class="right"><span class="${best && best.ev >= 0 ? 'pos' : 'muted'}">${best ? pct(best.ev) : '—'}</span><br><span class="muted small">best EV</span></span></summary>
      ${mp ? `<div class="chips"><span class="chip ${mp.cls}">${esc(mp.text)}</span></div>` : ''}
      <div class="scroll"><table class="tbl"><tr><th>Market</th><th>Pick</th><th>Best</th><th>Fair</th><th>EV</th><th>Stake</th><th></th></tr>
      ${rows.sort((a, b) => (a.mk + a.name).localeCompare(b.mk + b.name)).map((r) => `<tr class="${r.ev == null || r.ev < r.threshold ? 'below' : ''}">
        <td>${esc(mkLabel(r.mk))}</td><td>${esc(selLabel(r))}</td>
        <td>${r.am != null ? `${fmtAm(r.am)} ${esc(bookName(r.book))}` : '—'}</td>
        <td>${r.p != null ? fmtAm(decToAm(1 / r.p)) : r.fairP != null ? fmtAm(decToAm(1 / r.fairP)) + '*' : '—'}</td>
        <td class="${r.ev == null ? '' : r.ev >= 0 ? 'pos' : 'neg'}">${r.kind === 'bound' && r.ev != null ? '≥' : ''}${pct(r.ev)}</td>
        <td>${r.size?.stake > 0 && r.ev >= r.threshold ? money(r.size.stake) : '—'}</td>
        <td><button data-act="details" data-id="${esc(r.id)}">⋯</button></td></tr>`).join('')}</table></div>
      <div class="chips">${rows[0] ? chipsFor({ ...rows[0], flags: { ...rows[0].flags, key: null, verify: false, kalshi: false, limited: false }, kind: 'exact', push: null, model: null, main: true, sharp: true }, an) : ''}</div>
      <div class="actions"><button data-act="news" data-id="${esc(an.id)}">${newsState(an).ok ? 'News ✓' : 'Mark news checked'}</button>
        <button data-act="deriv" data-id="${esc(an.id)}">Load more markets…</button></div>
    </details>`;
  }
  const hid = S.hiddenNY[key];
  if (hid?.length) h += `<div class="note">Hidden (NY law bars betting on NY college teams): ${hid.map(esc).join('; ')}</div>`;
  if (sp.college) h += `<div class="note">College player props are illegal in NY and are never fetched.</div>`;
  $('#main').innerHTML = h;
}

function renderParlays() {
  const legs = S.rows.filter((r) => r.book && r.ev != null && r.ev > 0 && r.p != null && !r.started).sort((a, b) => b.ev - a.ev);
  const sel = legs.filter((r) => S.parlaySel.has(r.id));
  let h = `<div class="note">Only legs that are +EV on their own are allowed. Combined EV assumes independent legs. Not on the main board on purpose.</div>`;
  if (sel.length) {
    const books = [...new Set(sel.map((r) => r.book))];
    const sameGame = new Set(sel.map((r) => r.eventId)).size < sel.length;
    const P = parlay(sel.map((r) => ({ p: r.p, dec: r.effDec, overround: 1 / (1 - (S.an[r.eventId].markets[r.mk].holds[r.book] || 0)) })));
    const manual = Number($('#pm-price')?.value || 0);
    const mDec = manual ? amToDec(manual) : null;
    h += `<div class="card"><b>${sel.length}-leg parlay</b> ${books.length > 1 ? '<span class="chip red">Legs at different books — can\'t combine</span>' : `@ ${esc(bookName(books[0]))}`}
      <div class="row3">Price if priced as independent: <b>${fmtAm(decToAm(P.dec))}</b> · Fair: ${fmtAm(decToAm(1 / P.p))} · EV <b class="${P.ev >= 0 ? 'pos' : 'neg'}">${pct(P.ev)}</b> · Book's compounded hold ${pctPlain(P.hold)}</div>
      ${sameGame ? `<div class="alert">Same-game legs: books usually price correlation into SGPs already, and the fair price above assumes independence. Enter the actual SGP price to check it.</div>` : ''}
      <div class="row3">Actual price offered: <input id="pm-price" type="number" placeholder="+600" value="${manual || ''}"> ${mDec ? `→ EV vs independent fair <b class="${P.p * mDec - 1 >= 0 ? 'pos' : 'neg'}">${pct(P.p * mDec - 1)}</b>` : ''}
      <button data-act="pm-calc">Check</button> <button data-act="pm-clear">Clear</button></div></div>`;
  }
  h += legs.length ? `<table class="tbl"><tr><th></th><th>Leg</th><th>Book</th><th>Price</th><th>EV</th></tr>${legs.map((r) => `<tr><td><input type="checkbox" data-act="pm-sel" data-id="${esc(r.id)}" ${S.parlaySel.has(r.id) ? 'checked' : ''}></td>
    <td>${esc(matchup(r))}<br><span class="muted small">${esc(mkLabel(r.mk))}: ${esc(selLabel(r))}</span></td><td>${esc(bookName(r.book))}</td><td>${fmtAm(r.am)}</td><td class="pos">${pct(r.ev)}</td></tr>`).join('')}</table>`
    : '<div class="note">No +EV legs right now.</div>';
  $('#main').innerHTML = h;
}

function renderArbs() {
  const res = Object.values(S.an).flatMap((an) => arbsAndMiddles(an, S.settings));
  let h = `<div class="note">Across your non-limited books only. Arbing and middling get accounts limited fast — use sparingly.</div>`;
  if (!res.length) h += '<div class="note">Nothing right now.</div>';
  h += res.map((x) => `<div class="card ${x.type === 'arb' ? 'hot' : ''}"><div class="row1"><span>${SPORT_BY_KEY[x.an.sport].short} · ${esc(matchup(x.an))}</span><span>${etTime(x.an.commence)}</span></div>
    <div class="row2"><span class="pick">${x.type === 'arb' ? 'Arb' : `Middle (${x.window} pts)`} · ${esc(mkLabel(x.mk))}</span><span class="ev ${x.margin >= 0 ? 'pos' : 'neg'}">${pct(x.margin, 2)}</span></div>
    <div class="row3">${x.legs.map((l, i) => `${esc(l.o.name)} ${l.o.point ?? ''} ${fmtAm(l.o.am)} @ ${esc(bookName(l.bk))} (stake ${pctPlain(x.stakes[i], 0)})`).join(' · ')}</div>
    ${x.prob != null ? `<div class="row3 muted">Chance both win (historical NFL): ${pctPlain(x.prob)} · EV of the middle ≈ ${pct(x.prob * (x.legs[0].o.effDec + x.legs[1].o.effDec - 2) * x.stakes[0] + x.margin)}</div>` : ''}</div>`).join('');
  $('#main').innerHTML = h;
}

function betLine(b) {
  const res = b.result ? `<b class="${b.pnl > 0 ? 'pos' : b.pnl < 0 ? 'neg' : ''}">${b.result.toUpperCase()} ${money(b.pnl)}</b>` : '<span class="muted">open</span>';
  const close = b.close ? `${b.close.p != null ? fmtAm(decToAm(1 / b.close.p)) : 'n/a'} <span class="muted small">(${esc(b.close.kind)}${b.close.minsBefore != null ? `, ${b.close.minsBefore}m before start` : ''}, ${esc(b.close.source || '')})</span>` : '<span class="muted">not yet</span>';
  return `<div class="card"><div class="row1"><span>${SPORT_BY_KEY[b.sport]?.short || b.sport} · ${esc(b.away)} @ ${esc(b.home)}</span><span>${etTime(b.commence)}</span></div>
    <div class="row2"><span class="pick">${b.source === 'model' ? '<span class="chip violet">MODEL</span> ' : ''}${esc(mkLabel(b.mk))}: ${esc(selLabel(b))}</span><span>${res}</span></div>
    <div class="row3">${fmtAm(b.am)} @ ${esc(bookName(b.book))} · stake ${money(b.stake)}${b.kalshi ? ` (${b.kalshi.contracts} contracts, fee ${money(b.kalshi.fee)})` : ''} · EV at bet ${pct(b.evAtBet)} · logged ${etTime(b.ts)}</div>
    <div class="row3">Close: ${close} · CLV <b class="${b.clv == null ? '' : b.clv >= 0 ? 'pos' : 'neg'}">${pct(b.clv, 2)}</b></div>
    <div class="actions">${['win', 'loss', 'push', 'void'].map((x) => `<button data-act="settle" data-id="${b.id}" data-r="${x}">${x}</button>`).join('')}
      <button data-act="manual-close" data-id="${b.id}">Enter close</button><button class="danger" data-act="del-bet" data-id="${b.id}">Delete</button></div></div>`;
}
function renderLog() {
  const open = S.bets.filter((b) => !b.result).sort((a, b) => new Date(a.commence) - new Date(b.commence));
  const done = S.bets.filter((b) => b.result).sort((a, b) => b.ts - a.ts);
  const ungradedSports = [...new Set(open.filter((b) => new Date(b.commence) < Date.now() - 3 * 3600e3).map((b) => b.sport))];
  const lastBackup = db.lsGet('lb.lastBackup', null);
  let h = `<div class="note">Closing lines: captured automatically if this page is open within ${S.settings.closeWindowMin} min of start (1 credit per market), from any refresh in that window (free), or estimated from your last refresh before start ("proxy"). You can also enter one by hand.
    ${lastBackup ? `Last backup ${agoMin(lastBackup)}.` : '<b>No backup yet.</b>'} <button data-act="export">Back up log</button> <label><input type="file" id="import" accept="application/json" hidden><button data-act="import">Restore</button></label></div>`;
  if (ungradedSports.length) h += `<div class="actions" style="margin-bottom:8px"><button data-act="grade" data-k="${ungradedSports.join(',')}">Auto-grade finished bets (${ungradedSports.length * 2} credits)</button></div>`;
  h += `<div class="section-title">Open (${open.length})</div>` + (open.map(betLine).join('') || '<div class="note">None.</div>');
  h += `<div class="section-title">Settled (${done.length})</div>` + (done.map(betLine).join('') || '<div class="note">None.</div>');
  $('#main').innerHTML = h;
}

function breakdown(bets, keyFn, label) {
  const groups = new Map();
  for (const b of bets) { const k = keyFn(b); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
  const rows = [...groups.entries()].map(([k, bs]) => {
    const clv = meanCI(bs.filter((b) => b.clv != null).map((b) => b.clv));
    const settled = bs.filter((b) => b.result && b.result !== 'void');
    const st = settled.reduce((s, b) => s + b.stake, 0), pnl = settled.reduce((s, b) => s + b.pnl, 0);
    const beat = bs.filter((b) => b.clv != null && b.clv > 0).length;
    return { k, n: bs.length, clv, roi: st ? pnl / st : null, pnl, beat: clv.n ? beat / clv.n : null };
  }).sort((a, b) => b.n - a.n);
  return { label, rows };
}
function verdictFor(row, total) {
  if (total < 100) return '';
  if (row.clv.n < 20) return '<span class="muted">too few</span>';
  if (row.clv.hi < 0) return '<b class="neg">Drop it — losing to the close</b>';
  if (row.clv.lo > 0) return '<b class="pos">Real edge</b>';
  return row.clv.mean < 0 ? '<span class="neg">Leaning negative</span>' : '<span class="muted">Not proven yet</span>';
}
function renderResults() {
  const bets = S.bets;
  const n = bets.length;
  const clv = meanCI(bets.filter((b) => b.clv != null).map((b) => b.clv));
  const settled = bets.filter((b) => b.result && b.result !== 'void');
  const st = settled.reduce((s, b) => s + b.stake, 0), pnl = settled.reduce((s, b) => s + b.pnl, 0);
  let h = '';
  if (n < 100) h += `<div class="verdict meh">${n} bets logged. Honest read needs about 100+ — ${100 - n} to go. Until then, results are mostly noise; watch CLV, not wins.</div>`;
  else if (clv.n >= 30) {
    const cls = clv.lo > 0 ? 'good' : clv.hi < 0 ? 'bad' : 'meh';
    const msg = clv.lo > 0 ? `You're beating the closing line by ${pct(clv.mean, 2)} on average (95% range ${pct(clv.lo, 2)} to ${pct(clv.hi, 2)}). That's a real edge — keep doing what's working below.`
      : clv.hi < 0 ? `You're losing to the closing line by ${pct(-clv.mean, 2)} on average. Over time that loses money even if recent results look good. Cut the negative areas below.`
        : `Average CLV ${pct(clv.mean, 2)}, but the range (${pct(clv.lo, 2)} to ${pct(clv.hi, 2)}) still includes zero. Not proven either way yet.`;
    h += `<div class="verdict ${cls}">${msg}</div>`;
  }
  h += `<div class="grid2"><div class="card">Bets <b>${n}</b> · settled ${settled.length}<br>Staked ${money(st)} · P/L <b class="${pnl >= 0 ? 'pos' : 'neg'}">${money(pnl)}</b> · ROI ${st ? pct(pnl / st) : '—'}</div>
    <div class="card">Avg CLV <b class="${clv.mean >= 0 ? 'pos' : 'neg'}">${pct(clv.mean, 2)}</b> over ${clv.n} bets with a close${clv.lo != null ? `<br><span class="muted small">95% range ${pct(clv.lo, 2)} to ${pct(clv.hi, 2)}</span>` : ''}</div></div>`;
  const evBucket = (b) => (b.evAtBet == null ? 'unknown' : b.evAtBet < 0.02 ? '<2%' : b.evAtBet < 0.04 ? '2–4%' : b.evAtBet < 0.08 ? '4–8%' : '8%+');
  for (const t of [breakdown(bets, (b) => (b.source === 'model' ? 'Model picks' : 'Price edges'), 'By source'), breakdown(bets, (b) => SPORT_BY_KEY[b.sport]?.short || b.sport, 'By sport'), breakdown(bets, (b) => mkLabel(b.mk), 'By market'),
    breakdown(bets, (b) => bookName(b.book), 'By book'), breakdown(bets, evBucket, 'By EV at bet')]) {
    h += `<div class="section-title">${t.label}</div><div class="scroll"><table class="tbl"><tr><th></th><th>Bets</th><th>Avg CLV</th><th>Beat close</th><th>ROI</th><th>P/L</th>${n >= 100 ? '<th>Verdict</th>' : ''}</tr>
      ${t.rows.map((r) => `<tr><td>${esc(r.k)}</td><td>${r.n}</td><td class="${r.clv.mean == null ? '' : r.clv.mean >= 0 ? 'pos' : 'neg'}">${pct(r.clv.mean, 2)}</td><td>${r.beat == null ? '—' : pctPlain(r.beat, 0)}</td>
        <td>${r.roi == null ? '—' : pct(r.roi)}</td><td>${money(r.pnl)}</td>${n >= 100 ? `<td>${verdictFor(r, n)}</td>` : ''}</tr>`).join('')}</table></div>`;
  }
  $('#main').innerHTML = h;
}

function field(k, label, type, help = '') {
  const v = S.settings[k];
  let input;
  if (type === 'pct') input = `<input type="number" step="0.1" data-set="${k}" data-type="pct" value="${+(v * 100).toFixed(3)}"> %`;
  else if (type === 'num') input = `<input type="number" step="any" data-set="${k}" data-type="num" value="${v}">`;
  else if (type === 'bool') input = `<input type="checkbox" data-set="${k}" data-type="bool" ${v ? 'checked' : ''}>`;
  else input = `<select data-set="${k}" data-type="str">${type.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  return `<div class="field"><span>${label}${help ? `<small>${help}</small>` : ''}</span><span>${input}</span></div>`;
}
function renderSettings() {
  const s = S.settings;
  const allBooks = [...Object.keys(SHARP_REFS), ...Object.keys(NY_BOOKS), ...Object.keys(EXCHANGES)];
  const cost = refreshCost(s.sports);
  const rm = ratingsMeta();
  $('#main').innerHTML = `
  <div class="card"><b>Odds API key</b><div class="row3"><input id="key" type="password" autocomplete="off" style="flex:1;min-width:200px" value="${esc(S.key)}" placeholder="paste key">
    <button data-act="save-key">Save</button><button data-act="test-key">Test (free)</button><button data-act="clear-key" class="danger">Remove</button></div>
    <div class="muted small">Stored only in this browser (localStorage). Sent only to api.the-odds-api.com. Free plan: 500 credits/month; Fanatics and Caesars prices need a paid plan.</div></div>
  <div class="grid2">
  <div class="card"><b>Bankroll & sizing</b>
    ${field('bankroll', 'Starting bankroll ($)', 'num')}${field('bankrollMode', 'Bankroll for sizing', ['start+settled', 'fixed'], 'start+settled adds settled P/L')}
    ${field('unit', 'Unit ($, reference only)', 'num', 'Stakes come from Kelly, not units')}${field('kellyMult', 'Kelly fraction', 'num', '0.25 = quarter Kelly')}
    ${field('maxBetPct', 'Max per bet', 'pct')}${field('dailyCapPct', 'Max staked per day', 'pct')}${field('minStake', 'Min stake ($)', 'num')}</div>
  <div class="card"><b>Edges & data</b>
    ${field('evMain', 'Min EV, main markets', 'pct')}${field('evDeriv', 'Min EV, derivatives/props', 'pct')}${field('evVerify', '"Verify" warning above', 'pct')}
    ${field('staleMin', 'Stale after (minutes)', 'num')}${field('devig', 'De-vig method', ['power', 'shin', 'mult'])}
    ${field('steamPp', 'Steam alert: sharp move ≥ (pp)', 'num')}${field('minConsensusBooks', 'Min independent books for consensus fair', 'num')}
    ${field('requireRobust', 'Price edges: must hold under every de-vig method', 'bool')}
    ${field('modelPickPp', 'Model pick: model beats market by (pts)', 'num')}${field('modelPickMaxPct', 'Model pick max stake', 'pct')}
    ${field('modelPickMinGames', 'Model pick: min games per team this season', 'num')}${field('kalshiFeeMult', 'Kalshi taker fee multiplier', 'num')}</div>
  <div class="card"><b>Credits</b>
    ${field('autoRefresh', 'Auto-refresh (off saves credits)', 'bool')}${field('autoRefreshMin', 'Every (minutes, min 10)', 'num')}${field('autoDailyCredits', 'Auto-refresh daily credit cap', 'num')}
    ${field('closeWindowMin', 'Capture close within (min of start)', 'num')}${field('historicalCloses', 'Use historical closes (paid plan, 10 credits each)', 'bool')}
    <div class="muted small">Refreshing all enabled sports costs ${cost} credits (${s.fetchBooks.length} books = ${Math.ceil(s.fetchBooks.length / 10)} region × 3 markets per sport).</div></div>
  <div class="card"><b>Sports & extras</b>
    ${SPORTS.map((sp) => `<div class="field"><span>${sp.short}</span><input type="checkbox" data-act="sport-toggle" data-k="${sp.key}" ${s.sports.includes(sp.key) ? 'checked' : ''}></div>`).join('')}
    ${field('showArbs', 'Show Middles/Arbs tab', 'bool')}
    <div class="muted small">Model ratings: ${rm ? `updated ${agoMin(new Date(rm.generatedAt).getTime())}` : 'not loaded'} (built daily by the repo's GitHub Action).</div></div>
  </div>
  <div class="card"><b>Book manager</b><div class="muted small">Fetch = included in odds calls (10 books per region of cost). Mine = you can bet there. Limited = you've been limited. Sharp = fair-value reference (never bettable).</div>
    <div class="scroll"><table class="tbl"><tr><th>Book</th><th>Fetch</th><th>Mine</th><th>Limited</th><th>Sharp ref</th></tr>
    ${allBooks.map((b) => `<tr><td>${esc(bookName(b))}${EXCHANGES[b] ? ' <span class="muted small">(prediction market; NY disputes it)</span>' : ''}${SHARP_REFS[b] ? ' <span class="muted small">(not legal in NY)</span>' : ''}</td>
      <td><input type="checkbox" data-act="book" data-list="fetchBooks" data-k="${b}" ${s.fetchBooks.includes(b) ? 'checked' : ''}></td>
      <td>${SHARP_REFS[b] ? '—' : `<input type="checkbox" data-act="book" data-list="myBooks" data-k="${b}" ${s.myBooks.includes(b) ? 'checked' : ''}>`}</td>
      <td>${SHARP_REFS[b] ? '—' : `<input type="checkbox" data-act="book" data-list="limited" data-k="${b}" ${s.limited.includes(b) ? 'checked' : ''}>`}</td>
      <td><input type="checkbox" data-act="book" data-list="sharpBooks" data-k="${b}" ${s.sharpBooks.includes(b) ? 'checked' : ''}></td></tr>`).join('')}</table></div>
    ${field('limitedMode', 'Limited books are', ['exclude', 'rank-lower'])}</div>
  <div class="card"><b>Data</b><div class="actions"><button data-act="export">Back up bet log</button><button data-act="import">Restore backup</button>
    <button class="danger" data-act="reset-settings">Reset settings</button></div></div>`;
}

function render() {
  try { renderInner(); } catch (e) {
    console.error(e);
    $('#main').innerHTML = `<div class="alert">Something broke while drawing this page: ${esc(e.message)}. Your bets and odds are saved. Try another tab or reload.</div>`;
  }
}
function renderInner() {
  recompute();
  renderTop(); renderTabs(); renderControls();
  const t = S.tab;
  if (t === 'best') renderBest();
  else if (SPORT_BY_KEY[t]) renderSport(t);
  else if (t === 'parlays') renderParlays();
  else if (t === 'arbs') renderArbs();
  else if (t === 'log') renderLog();
  else if (t === 'results') renderResults();
  else if (t === 'settings') renderSettings();
}
function setTab(t) { S.tab = t; db.lsSet('lb.tab', t); render(); window.scrollTo(0, 0); }

// ---------------- modals ----------------
function openModal(html) { const m = $('#modal'); m.innerHTML = `<div class="sheet">${html}</div>`; m.hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

function detailsModal(r) {
  const an = S.an[r.eventId];
  const m = an.markets[r.mk];
  const rowsHtml = Object.entries(m.books).map(([bk, b]) => {
    const o = b.outcomes.find((x) => x.name === r.name && (x.desc || null) === (r.desc || null));
    if (!o) return '';
    return `<tr><td>${esc(bookName(bk))}${S.settings.myBooks.includes(bk) ? ' ★' : ''}</td><td>${o.point ?? ''}</td><td>${fmtAm(o.am)}</td>
      <td>${m.holds[bk] != null ? pctPlain(m.holds[bk]) : '—'}</td><td>${stamp(b.lastUpdate)}</td></tr>`;
  }).join('');
  const missing = S.settings.fetchBooks.filter((bk) => !m.books[bk]).map(bookName);
  const ns = newsState(an);
  openModal(`<b>${esc(matchup(an))}</b><div class="muted small">${etTime(an.commence)} · ${esc(mkLabel(r.mk))}: ${esc(selLabel(r))}</div>
    <div class="row3">Fair: ${r.p != null ? `${(r.p * 100).toFixed(1)}% (${fmtAm(decToAm(1 / r.p))})` : '—'} · Source: ${esc(r.fairSource || 'none')} · Method: ${esc(r.fairMethod || '—')}${r.kind === 'keyadj' ? ` · moved from ${r.fairPoint} using historical NFL margins` : ''}</div>
    ${r.push != null ? `<div class="row3 muted">Push chance at this line (NFL history): ${pctPlain(r.push)}. EV shown ignores pushes (refund).</div>` : ''}
    ${r.model?.pm != null ? `<div class="row3 muted">Model (second opinion): ${pctPlain(r.model.pm)}${r.model.low ? ' — small sample' : ''}</div>` : ''}
    <table class="tbl"><tr><th>Book</th><th>Line</th><th>Price</th><th>Hold</th><th>Updated</th></tr>${rowsHtml}</table>
    ${missing.length ? `<div class="muted small">No price from: ${missing.map(esc).join(', ')}${missing.includes('Fanatics') || missing.includes('Caesars') ? ' (Fanatics/Caesars need a paid Odds API plan)' : ''}</div>` : ''}
    <div class="row3">News: ${ns.ok ? `checked ${agoMin(ns.t)}` : 'not checked'} — ${(NEWS_LINKS[an.sport] || []).map(([l, u]) => `<a href="${u}" target="_blank" rel="noopener">${l}</a>`).join(' · ') || `<a href="https://news.google.com/search?q=${encodeURIComponent(an.home + ' ' + an.away + ' injury')}" target="_blank" rel="noopener">search news</a>`}. Never trust injury info you haven't seen from a source.</div>
    <div class="actions"><button data-act="close-modal">Close</button></div>`);
}

function betModal(r, src = 'price') {
  const s = S.settings;
  const sz = (src === 'model' ? r.mSize : r.size) || { stake: 0 };
  openModal(`<b>Log bet</b><div class="muted small">${esc(matchup(r))} · ${etTime(r.commence)}</div>
    <div class="row2"><span class="pick">${esc(mkLabel(r.mk))}: ${esc(r.desc ? r.desc + ' ' : '')}${esc(r.name)}</span></div>
    <div class="field"><span>Book</span><select id="b-book">${s.myBooks.map((b) => `<option value="${b}" ${b === r.book ? 'selected' : ''}>${esc(bookName(b))}</option>`).join('')}</select></div>
    ${r.point != null ? `<div class="field"><span>Line</span><input id="b-point" type="number" step="0.25" value="${r.point}"></div>` : ''}
    <div class="field"><span>Price you got (American)</span><input id="b-am" type="number" value="${r.am}"></div>
    <div class="field"><span>Stake ($)<small>Suggested ${money(sz.stake)}${sz.limitedBy ? ` (${sz.limitedBy})` : ''} · unit ${money(s.unit)}</small></span><input id="b-stake" type="number" step="0.01" value="${sz.stake || ''}"></div>
    <div id="b-calc" class="row3 muted"></div>
    <div class="actions"><button class="primary" data-act="save-bet" data-src="${src}" data-id="${esc(r.id)}">Save bet</button><button data-act="close-modal">Cancel</button></div>`);
  updateBetCalc(r);
}
function updateBetCalc(r) {
  const el = $('#b-calc'); if (!el) return;
  const am = Number($('#b-am').value), stake = Number($('#b-stake').value), bk = $('#b-book').value;
  const point = $('#b-point') ? Number($('#b-point').value) : null;
  if (!am || (am > -100 && am < 100)) { el.textContent = 'Enter a valid American price.'; return; }
  let effDec = bk === 'kalshi' ? kalshiEffDec(amToDec(am), S.settings.kalshiFeeMult) : amToDec(am);
  let extra = '';
  if (bk === 'kalshi' && stake > 0) {
    const k = kalshiOrder(stake, amToDec(am), S.settings.kalshiFeeMult);
    if (k.effDec) effDec = k.effDec;
    extra = ` · Kalshi: ${k.contracts} contracts at ${k.price.toFixed(2)}, fee ${money(k.fee)}, cost ${money(k.cost)}`;
  }
  const p = point != null && point !== r.point ? null : r.p;
  el.innerHTML = p != null ? `EV at this price: <b class="${p * effDec - 1 >= 0 ? 'pos' : 'neg'}">${pct(p * effDec - 1)}</b>${extra}` : `Line changed — EV recalculated at close only${extra}`;
}
async function saveBet(r, src = 'price') {
  const am = Number($('#b-am').value), stake = Number($('#b-stake').value), bk = $('#b-book').value;
  const point = $('#b-point') ? Number($('#b-point').value) : null;
  if (!am || (am > -100 && am < 100) || !(stake > 0)) { toast('Check the price and stake.'); return; }
  let effDec = bk === 'kalshi' ? kalshiEffDec(amToDec(am), S.settings.kalshiFeeMult) : amToDec(am);
  let kalshi = null;
  if (bk === 'kalshi') { const k = kalshiOrder(stake, amToDec(am), S.settings.kalshiFeeMult); if (k.effDec) { effDec = k.effDec; kalshi = k; } }
  const p = point != null && point !== r.point ? null : r.p;
  const b = {
    id: `b${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(), sport: r.sport, eventId: r.eventId, home: r.home, away: r.away, commence: r.commence,
    mk: r.mk, name: r.name, desc: r.desc, point, book: bk, am, dec: amToDec(am), effDec, stake: kalshi ? kalshi.cost : stake, kalshi,
    fairPAtBet: p, fairSource: r.fairSource, evAtBet: p != null ? p * effDec - 1 : null, modelAtBet: r.model?.pm ?? null, source: src,
    close: null, clv: null, result: null, pnl: null,
  };
  S.bets.push(b); await db.put('bets', b);
  closeModal(); toast('Bet logged. Closing line will be tracked.'); render();
}
function manualCloseModal(b) {
  openModal(`<b>Enter closing line</b><div class="muted small">${esc(b.away)} @ ${esc(b.home)} · ${esc(mkLabel(b.mk))}: ${esc(selLabel(b))}</div>
    <div class="muted small">Use the sharp book's closing prices for both sides at your line, if you have them.</div>
    <div class="field"><span>Your side (American)</span><input id="c-a" type="number"></div>
    <div class="field"><span>Other side (American)</span><input id="c-b" type="number"></div>
    <div class="actions"><button class="primary" data-act="save-close" data-id="${b.id}">Save</button><button data-act="close-modal">Cancel</button></div>`);
}

// ---------------- grading ----------------
function gradeBet(b, ev) {
  const sc = Object.fromEntries((ev.scores || []).map((x) => [x.name, Number(x.score)]));
  const hs = sc[b.home], as = sc[b.away];
  if (hs == null || as == null || !MAIN_MARKETS.has(b.mk)) return null;
  let r;
  if (b.mk === 'h2h') {
    if (b.name === 'Draw') r = hs === as ? 'win' : 'loss';
    else { const me = b.name === b.home ? hs : as, op = b.name === b.home ? as : hs; r = me > op ? 'win' : me < op ? 'loss' : b.sport.startsWith('soccer') ? 'loss' : 'push'; }
  } else if (b.mk === 'spreads') {
    const me = b.name === b.home ? hs : as, op = b.name === b.home ? as : hs; const v = me + b.point - op;
    r = v > 0 ? 'win' : v < 0 ? 'loss' : 'push';
  } else {
    const v = b.name === 'Over' ? hs + as - b.point : b.point - (hs + as);
    r = v > 0 ? 'win' : v < 0 ? 'loss' : 'push';
  }
  return r;
}
function settle(b, r) {
  b.result = r;
  b.pnl = r === 'win' ? b.stake * (b.effDec - 1) : r === 'loss' ? -b.stake : 0;
}

// ---------------- events ----------------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) { if (e.target.id === 'modal') closeModal(); return; }
  const act = t.dataset.act;
  const rowById = (id) => S.rows.find((r) => r.id === id);
  if (act !== 'pm-sel' && act !== 'sport-toggle' && act !== 'book' && t.tagName !== 'INPUT') e.preventDefault();
  switch (act) {
    case 'tab': setTab(t.dataset.k); break;
    case 'refresh': refresh([t.dataset.k]); break;
    case 'refresh-all': refresh(S.settings.sports); break;
    case 'details': { const r = rowById(t.dataset.id); if (r) detailsModal(r); break; }
    case 'bet': { const r = rowById(t.dataset.id); if (r) betModal(r, t.dataset.src || 'price'); break; }
    case 'save-bet': { const r = rowById(t.dataset.id); if (r) saveBet(r, t.dataset.src || 'price'); break; }
    case 'close-modal': closeModal(); break;
    case 'news': S.news[t.dataset.id] = Date.now(); db.lsSet('lb.news', S.news); render(); break;
    case 'deriv': {
      const an = S.an[t.dataset.id]; const mks = DERIV_MARKETS[an.sport] || [];
      openModal(`<b>Load more markets</b><div class="muted small">${esc(matchup(an))}. Each market that comes back costs 1 credit. Thinner markets: lower limits, noisier fair prices, ${pctPlain(S.settings.evDeriv)} minimum EV.</div>
        ${mks.map((m) => `<div class="field"><span>${esc(mkLabel(m))}</span><input type="checkbox" class="dm" value="${m}"></div>`).join('')}
        <div class="actions"><button class="primary" data-act="deriv-go" data-id="${an.id}">Load</button><button data-act="close-modal">Cancel</button></div>`);
      break;
    }
    case 'deriv-go': {
      const an = S.an[t.dataset.id]; const mks = [...document.querySelectorAll('.dm:checked')].map((x) => x.value);
      if (!mks.length) return;
      closeModal();
      try {
        const { data } = await api.eventOdds(S.key, an.sport, an.id, mks, S.settings.fetchBooks);
        const d = S.data[an.sport]; const ev = d.events.find((x) => x.id === an.id);
        for (const b of data.bookmakers || []) {
          let eb = ev.bookmakers.find((x) => x.key === b.key);
          if (!eb) { eb = { key: b.key, title: b.title, markets: [] }; ev.bookmakers.push(eb); }
          for (const m of b.markets) { eb.markets = eb.markets.filter((x) => x.key !== m.key); eb.markets.push(m); }
        }
        await db.kvSet(`odds:${an.sport}`, d); toast(`Loaded ${mks.length} market(s).`); render();
      } catch (err) { toast(err.message, 6000); }
      break;
    }
    case 'pm-sel': if (t.checked) S.parlaySel.add(t.dataset.id); else S.parlaySel.delete(t.dataset.id); renderParlays(); break;
    case 'pm-calc': renderParlays(); break;
    case 'pm-clear': S.parlaySel.clear(); renderParlays(); break;
    case 'settle': { const b = S.bets.find((x) => x.id === t.dataset.id); settle(b, t.dataset.r); await db.put('bets', b); render(); break; }
    case 'del-bet': { if (!confirm('Delete this bet?')) return; S.bets = S.bets.filter((x) => x.id !== t.dataset.id); await db.del('bets', t.dataset.id); render(); break; }
    case 'manual-close': manualCloseModal(S.bets.find((x) => x.id === t.dataset.id)); break;
    case 'save-close': {
      const b = S.bets.find((x) => x.id === t.dataset.id);
      const a = Number($('#c-a').value), o = Number($('#c-b').value);
      if (!a || !o) { toast('Enter both prices.'); return; }
      const d = devig([1 / amToDec(a), 1 / amToDec(o)], S.settings.devig);
      applyClose(b, { p: d.p[0], source: 'manual', kind: 'manual', t: Date.now() });
      await db.put('bets', b); closeModal(); render(); break;
    }
    case 'grade': {
      const sports = t.dataset.k.split(',');
      for (const sp of sports) {
        try {
          const { data } = await api.scores(S.key, sp, 3);
          for (const b of S.bets.filter((x) => x.sport === sp && !x.result)) {
            const ev = data.find((x) => x.id === b.eventId && x.completed);
            if (!ev) continue;
            const r = gradeBet(b, ev);
            if (r) { settle(b, r); await db.put('bets', b); }
          }
        } catch (err) { toast(err.message, 6000); }
      }
      render(); break;
    }
    case 'export': {
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), bets: S.bets, settings: S.settings }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `line-board-backup-${etDate(Date.now())}.json`; a.click();
      db.lsSet('lb.lastBackup', Date.now()); toast('Backup downloaded.'); break;
    }
    case 'import': {
      let inp = $('#import');
      if (!inp) { inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json'; }
      inp.onchange = async () => {
        try {
          const j = JSON.parse(await inp.files[0].text());
          const have = new Set(S.bets.map((b) => b.id));
          const add = (j.bets || []).filter((b) => !have.has(b.id));
          S.bets.push(...add); await db.putMany('bets', add);
          toast(`Restored ${add.length} bet(s).`); render();
        } catch { toast('Not a valid backup file.'); }
      };
      inp.click(); break;
    }
    case 'save-key': S.key = $('#key').value.trim(); db.lsSet('lb.key', S.key); toast('Key saved in this browser.'); break;
    case 'clear-key': S.key = ''; db.lsSet('lb.key', ''); render(); break;
    case 'test-key': {
      S.key = $('#key').value.trim(); db.lsSet('lb.key', S.key);
      try { const { credits } = await api.sports(S.key); toast(`Key works. Credits left: ${credits.remaining ?? 'unknown (header hidden)'}`); render(); } catch (err) { toast(err.message, 6000); }
      break;
    }
    case 'reset-settings': if (confirm('Reset all settings to defaults? (Bets are kept.)')) { S.settings = { ...DEFAULT_SETTINGS }; saveSettings(); render(); } break;
    case 'sport-toggle': {
      const k = t.dataset.k; const set = new Set(S.settings.sports);
      if (t.checked) set.add(k); else set.delete(k);
      S.settings.sports = SPORTS.map((s) => s.key).filter((x) => set.has(x)); saveSettings(); render(); break;
    }
    case 'book': {
      const list = t.dataset.list, k = t.dataset.k; const set = new Set(S.settings[list]);
      if (t.checked) set.add(k); else set.delete(k);
      S.settings[list] = [...set];
      if (list === 'fetchBooks' && S.settings.fetchBooks.length > 10) toast(`${S.settings.fetchBooks.length} books = double the credit cost per refresh.`);
      saveSettings(); render(); break;
    }
    default: break;
  }
});
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.tagName === 'DETAILS' && d.dataset.eid) { if (d.open) S.openGames.add(d.dataset.eid); else S.openGames.delete(d.dataset.eid); }
}, true);
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset?.set) {
    const k = t.dataset.set, ty = t.dataset.type;
    let v = ty === 'bool' ? t.checked : ty === 'pct' ? Number(t.value) / 100 : ty === 'num' ? Number(t.value) : t.value;
    if ((ty === 'num' || ty === 'pct') && !isFinite(v)) return;
    S.settings[k] = v; saveSettings();
    if (k === 'autoRefresh' || k === 'autoRefreshMin') scheduleAuto();
    renderTop(); renderControls(); renderTabs();
  }
});
document.addEventListener('input', (e) => {
  if (['b-am', 'b-stake', 'b-book', 'b-point'].includes(e.target.id)) {
    const id = $('[data-act="save-bet"]')?.dataset.id; const r = S.rows.find((x) => x.id === id); if (r) updateBetCalc(r);
  }
});

// ---------------- boot ----------------
(async function boot() {
  db.askPersist();
  try {
    S.bets = await db.getAll('bets');
    for (const sp of SPORTS) {
      const d = await db.kvGet(`odds:${sp.key}`); if (d) S.data[sp.key] = d;
      const sch = await db.kvGet(`sched:${sp.key}`); if (sch) S.sched[sp.key] = sch;
    }
    await loadSnaps();
  } catch (e) { toast(`Storage unavailable: ${e.message}. Bets won't be saved.`, 8000); }
  await loadRatings();
  await fillProxyCloses();
  render();
  scheduleAuto();
  loadWeather(Object.values(S.an)).then(() => { if (S.tab !== 'settings' && $('#modal').hidden) render(); });
  setInterval(() => {
    closeLoop();
    const typing = document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
    if ($('#modal').hidden && !typing && S.tab !== 'settings') render();
  }, 60e3);
})();
