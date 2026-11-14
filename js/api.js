// The Odds API client. Every call reports its credit cost; nothing here runs on its own.
import { lsGet, lsSet } from './store.js';

const BASE = 'https://api.the-odds-api.com/v4';
const regionsFor = (books) => Math.max(1, Math.ceil(books.length / 10));

export function creditState() {
  return lsGet('lb.credits', { remaining: null, used: null, at: null, month: null, monthUsed: 0, day: null, dayUsed: 0 });
}
function track(cost, headers) {
  const c = creditState();
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const day = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (c.month !== month) { c.month = month; c.monthUsed = 0; }
  if (c.day !== day) { c.day = day; c.dayUsed = 0; }
  const last = headers.last != null ? Number(headers.last) : cost;
  c.monthUsed += last; c.dayUsed += last;
  if (headers.remaining != null) { c.remaining = Number(headers.remaining); c.used = Number(headers.used); }
  else if (c.remaining != null) c.remaining = Math.max(0, c.remaining - last);
  c.at = now.toISOString();
  lsSet('lb.credits', c);
  return c;
}

async function call(path, params, key, estCost) {
  if (!key) throw new Error('No API key. Add it in Settings.');
  const u = new URL(BASE + path);
  u.searchParams.set('apiKey', key);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') u.searchParams.set(k, v);
  const r = await fetch(u.toString());
  const headers = {
    remaining: r.headers.get('x-requests-remaining'),
    used: r.headers.get('x-requests-used'),
    last: r.headers.get('x-requests-last'),
  };
  if (!r.ok) {
    let msg = `${r.status}`;
    try { const j = await r.json(); msg += ` ${j.message || j.error_code || ''}`; } catch { /* ignore */ }
    if (r.status === 401) msg += ' (bad API key?)';
    if (r.status === 429) msg += ' (out of credits or rate limited)';
    track(0, headers);
    throw new Error(`Odds API error ${msg}`);
  }
  const data = await r.json();
  const credits = track(estCost, headers);
  return { data, headers, credits };
}

export const costOdds = (markets, books) => markets.length * regionsFor(books);

// Free: list of sports (also returns quota headers - used to test the key).
export const sports = (key) => call('/sports', {}, key, 0);

export const odds = (key, sport, markets, books) =>
  call(`/sports/${sport}/odds`, { bookmakers: books.join(','), markets: markets.join(','), oddsFormat: 'american', dateFormat: 'iso' }, key, costOdds(markets, books));

export const eventOdds = (key, sport, eventId, markets, books) =>
  call(`/sports/${sport}/events/${eventId}/odds`, { bookmakers: books.join(','), markets: markets.join(','), oddsFormat: 'american', dateFormat: 'iso' }, key, costOdds(markets, books));

export const scores = (key, sport, daysFrom = 3) => call(`/sports/${sport}/scores`, { daysFrom, dateFormat: 'iso' }, key, daysFrom ? 2 : 1);

// Paid plans only: 10x cost.
export const historicalEventOdds = (key, sport, eventId, dateIso, markets, books) =>
  call(`/historical/sports/${sport}/events/${eventId}/odds`, { date: dateIso, bookmakers: books.join(','), markets: markets.join(','), oddsFormat: 'american', dateFormat: 'iso' }, key, 10 * costOdds(markets, books));
