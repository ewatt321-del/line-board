"""Builds data/ratings.json: simple team ratings used ONLY as a second opinion on the dashboard.

Runs daily in GitHub Actions (see .github/workflows/ratings.yml). Sources, all free and public:
  NFL  - nflverse/nfldata games.csv (GitHub)
  CFB  - sportsdataverse/cfbfastR-data schedules (GitHub)
  NBA  - ESPN public scoreboard JSON
  CBB  - ESPN public scoreboard JSON (Division I)
  EPL  - ESPN public scoreboard JSON (current season) + openfootball/football.json (last season)

Model, US sports: weighted ridge regression on points scored,
    points_home = mu + hfa + off_home - def_away,  points_away = mu + off_away - def_home
with time-decay weights and last season down-weighted. Margin/total sigmas come from residuals.
Model, EPL: Dixon-Coles (Poisson attack/defence, low-score correction rho, time decay).
If a source fails, the previous ratings for that sport are kept and marked stale.
"""
import csv, io, json, math, os, sys, time, urllib.request, datetime as dt

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'ratings.json')
CACHE = os.path.join(ROOT, 'data', 'cache')
TODAY = dt.date.today()
UA = {'User-Agent': 'line-board-ratings/1.0'}


def get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return r.read()
        except Exception as e:  # noqa
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def daterange(a, b):
    d = a
    while d <= b:
        yield d
        d += dt.timedelta(days=1)


# ---------------- ridge points model ----------------
def ridge_points(games, half_life_days, lam, min_sigma_m, min_sigma_t):
    """games: list of dict(home, away, hs, as_, date: date, neutral: bool, w: base weight)"""
    teams = sorted({g['home'] for g in games} | {g['away'] for g in games})
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    # params: mu, hfa, off[n], def[n]
    P = 2 + 2 * n
    rows, ys, ws = [], [], []
    for g in games:
        age = (TODAY - g['date']).days
        w = g.get('w', 1.0) * 0.5 ** (age / half_life_days)
        h, a = idx[g['home']], idx[g['away']]
        r = np.zeros(P); r[0] = 1; r[1] = 0 if g['neutral'] else 1; r[2 + h] = 1; r[2 + n + a] = -1
        rows.append(r); ys.append(g['hs']); ws.append(w)
        r = np.zeros(P); r[0] = 1; r[2 + a] = 1; r[2 + n + h] = -1
        rows.append(r); ys.append(g['as_']); ws.append(w)
    X = np.array(rows); y = np.array(ys, float); W = np.array(ws)
    sw = np.sqrt(W)
    Xw = X * sw[:, None]; yw = y * sw
    reg = np.zeros(P); reg[2:] = math.sqrt(lam)
    Xa = np.vstack([Xw, np.diag(reg)]); ya = np.concatenate([yw, np.zeros(P)])
    beta, *_ = np.linalg.lstsq(Xa, ya, rcond=None)
    mu, hfa = beta[0], beta[1]
    off = beta[2:2 + n]; de = beta[2 + n:]
    # residual sigmas on margin and total (weighted)
    em, et, ww = [], [], []
    for g in games:
        h, a = idx[g['home']], idx[g['away']]
        hf = 0 if g['neutral'] else hfa
        ph = mu + hf + off[h] - de[a]; pa = mu + off[a] - de[h]
        em.append((g['hs'] - g['as_']) - (ph - pa)); et.append((g['hs'] + g['as_']) - (ph + pa))
        ww.append(g.get('w', 1.0) * 0.5 ** ((TODAY - g['date']).days / half_life_days))
    ww = np.array(ww)
    sm = math.sqrt(float(np.sum(ww * np.square(em)) / np.sum(ww))) * 1.05
    st = math.sqrt(float(np.sum(ww * np.square(et)) / np.sum(ww))) * 1.05
    cnt = {t: 0 for t in teams}
    for g in games:
        if g.get('w', 1.0) >= 1.0:
            cnt[g['home']] += 1; cnt[g['away']] += 1
    return {
        'type': 'ridge', 'mu': round(float(mu), 3), 'hfa': round(float(hfa), 3),
        'sigmaMargin': round(max(sm, min_sigma_m), 3), 'sigmaTotal': round(max(st, min_sigma_t), 3),
        'teams': {t: {'off': round(float(off[i]), 3), 'def': round(float(de[i]), 3), 'n': cnt[t]} for t, i in idx.items()},
        'games': len(games),
    }


# ---------------- Dixon-Coles ----------------
def dixon_coles(matches, xi=0.0019):
    from scipy.optimize import minimize
    teams = sorted({m['home'] for m in matches} | {m['away'] for m in matches})
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    H = np.array([idx[m['home']] for m in matches]); A = np.array([idx[m['away']] for m in matches])
    x = np.array([m['hg'] for m in matches]); y = np.array([m['ag'] for m in matches])
    w = np.array([m.get('w', 1.0) * math.exp(-xi * (TODAY - m['date']).days) for m in matches])
    from scipy.special import gammaln
    lfx, lfy = gammaln(x + 1), gammaln(y + 1)

    def nll(th):
        att = th[:n]; de = th[n:2 * n]; home = th[2 * n]; rho = th[2 * n + 1]
        att = att - att.mean()
        lam = np.exp(home + att[H] + de[A]); mu = np.exp(att[A] + de[H])
        tau = np.ones_like(lam)
        m00 = (x == 0) & (y == 0); m01 = (x == 0) & (y == 1); m10 = (x == 1) & (y == 0); m11 = (x == 1) & (y == 1)
        tau[m00] = 1 - lam[m00] * mu[m00] * rho
        tau[m01] = 1 + lam[m01] * rho
        tau[m10] = 1 + mu[m10] * rho
        tau[m11] = 1 - rho
        tau = np.clip(tau, 1e-10, None)
        ll = np.log(tau) + x * np.log(lam) - lam - lfx + y * np.log(mu) - mu - lfy
        return -np.sum(w * ll) + 0.01 * np.sum(th[:2 * n] ** 2)

    th0 = np.concatenate([np.zeros(n), np.zeros(n), [0.25, -0.05]])
    bounds = [(-3, 3)] * (2 * n) + [(-1, 1), (-0.3, 0.3)]
    r = minimize(nll, th0, method='L-BFGS-B', bounds=bounds)
    th = r.x
    att = th[:n] - th[:n].mean()
    cnt = {t: 0 for t in teams}
    for m in matches:
        if m.get('w', 1.0) >= 1.0:
            cnt[m['home']] += 1; cnt[m['away']] += 1
    return {'type': 'dixon-coles', 'home': round(float(th[2 * n]), 4), 'rho': round(float(th[2 * n + 1]), 4),
            'teams': {t: {'att': round(float(att[i]), 4), 'def': round(float(th[n + i]), 4), 'n': cnt[t]} for t, i in idx.items()},
            'games': len(matches), 'converged': bool(r.success)}


# ---------------- sources ----------------
NFL_ABBR = {
    'ARI': 'Arizona Cardinals', 'ATL': 'Atlanta Falcons', 'BAL': 'Baltimore Ravens', 'BUF': 'Buffalo Bills', 'CAR': 'Carolina Panthers',
    'CHI': 'Chicago Bears', 'CIN': 'Cincinnati Bengals', 'CLE': 'Cleveland Browns', 'DAL': 'Dallas Cowboys', 'DEN': 'Denver Broncos',
    'DET': 'Detroit Lions', 'GB': 'Green Bay Packers', 'HOU': 'Houston Texans', 'IND': 'Indianapolis Colts', 'JAX': 'Jacksonville Jaguars',
    'KC': 'Kansas City Chiefs', 'LA': 'Los Angeles Rams', 'LAC': 'Los Angeles Chargers', 'LV': 'Las Vegas Raiders', 'MIA': 'Miami Dolphins',
    'MIN': 'Minnesota Vikings', 'NE': 'New England Patriots', 'NO': 'New Orleans Saints', 'NYG': 'New York Giants', 'NYJ': 'New York Jets',
    'PHI': 'Philadelphia Eagles', 'PIT': 'Pittsburgh Steelers', 'SEA': 'Seattle Seahawks', 'SF': 'San Francisco 49ers',
    'TB': 'Tampa Bay Buccaneers', 'TEN': 'Tennessee Titans', 'WAS': 'Washington Commanders',
}


def season_of_football(d):
    return d.year if d.month >= 8 else d.year - 1


def nfl():
    raw = get('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv').decode()
    cur = season_of_football(TODAY)
    games = []
    for r in csv.DictReader(io.StringIO(raw)):
        if r['home_score'] == '' or int(r['season']) < cur - 1:
            continue
        if r['home_team'] not in NFL_ABBR or r['away_team'] not in NFL_ABBR:
            continue
        games.append({'home': NFL_ABBR[r['home_team']], 'away': NFL_ABBR[r['away_team']], 'hs': int(r['home_score']), 'as_': int(r['away_score']),
                      'date': dt.date.fromisoformat(r['gameday']), 'neutral': r['location'] == 'Neutral',
                      'w': 1.0 if int(r['season']) == cur else 0.35})
    m = ridge_points(games, half_life_days=150, lam=6.0, min_sigma_m=13.5, min_sigma_t=13.0)
    m['source'] = 'nflverse/nfldata games.csv'
    return m


def cfb():
    cur = season_of_football(TODAY)
    games = []
    for season in (cur - 1, cur):
        raw = get(f'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_{season}.csv').decode()
        for r in csv.DictReader(io.StringIO(raw)):
            if r['home_points'] in ('', 'NA') or r['away_points'] in ('', 'NA'):
                continue
            if r['home_division'] != 'fbs' or r['away_division'] != 'fbs':  # FBS vs FBS only; FCS mismatches distort home-field
                continue
            games.append({'home': r['home_team'], 'away': r['away_team'], 'hs': int(float(r['home_points'])), 'as_': int(float(r['away_points'])),
                          'date': dt.date.fromisoformat(r['start_date'][:10]), 'neutral': r['neutral_site'] in ('TRUE', 'True', 'true'),
                          'w': 1.0 if season == cur else 0.3})
    m = ridge_points(games, half_life_days=120, lam=4.0, min_sigma_m=14.0, min_sigma_t=14.0)
    m['source'] = 'sportsdataverse/cfbfastR-data schedules'
    return m


def espn_games(path, start, end, cache_name, extra=''):
    if os.environ.get('SKIP_ESPN'):
        raise RuntimeError('ESPN skipped (local test)')
    os.makedirs(CACHE, exist_ok=True)
    cpath = os.path.join(CACHE, cache_name)
    cache = json.load(open(cpath)) if os.path.exists(cpath) else {}
    out = []
    for d in daterange(start, min(end, TODAY - dt.timedelta(days=1))):
        key = d.isoformat()
        # Re-fetch the last 3 days in case of late corrections; older days come from cache.
        if key not in cache or (TODAY - d).days <= 3:
            try:
                js = json.loads(get(f'https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard?dates={d:%Y%m%d}{extra}'))
            except Exception as e:  # noqa
                print('espn fail', path, key, e, file=sys.stderr)
                continue
            day = []
            for ev in js.get('events', []):
                comp = (ev.get('competitions') or [{}])[0]
                if not comp.get('status', ev.get('status', {})).get('type', {}).get('completed'):
                    continue
                cs = comp.get('competitors', [])
                h = next((c for c in cs if c.get('homeAway') == 'home'), None)
                a = next((c for c in cs if c.get('homeAway') == 'away'), None)
                if not h or not a:
                    continue
                try:
                    day.append({'home': h['team'].get('displayName'), 'away': a['team'].get('displayName'),
                                'hloc': h['team'].get('location'), 'aloc': a['team'].get('location'),
                                'hs': int(float(h.get('score', 0))), 'as_': int(float(a.get('score', 0))), 'neutral': bool(comp.get('neutralSite'))})
                except Exception:  # noqa
                    continue
            cache[key] = day
            time.sleep(0.15)
        for g in cache.get(key, []):
            out.append({**g, 'date': d})
    json.dump(cache, open(cpath, 'w'), separators=(',', ':'))
    return out


def nba():
    cur_start = dt.date(2026, 10, 20) if TODAY >= dt.date(2026, 10, 20) else dt.date(2025, 10, 21)
    prev = espn_games('basketball/nba', dt.date(2025, 10, 21), dt.date(2026, 4, 12), 'nba.json')
    cur = espn_games('basketball/nba', cur_start, TODAY, 'nba.json')
    games = [{**g, 'w': 0.4} for g in prev if g['date'] < cur_start] + [{**g, 'w': 1.0} for g in cur]
    m = ridge_points(games, half_life_days=60, lam=8.0, min_sigma_m=11.0, min_sigma_t=16.0)
    m['source'] = 'ESPN scoreboard (NBA)'
    return m


def cbb():
    cur_start = dt.date(2026, 11, 2)
    prev = espn_games('basketball/mens-college-basketball', dt.date(2025, 11, 3), dt.date(2026, 3, 15), 'cbb.json', '&groups=50&limit=500')
    cur = espn_games('basketball/mens-college-basketball', cur_start, TODAY, 'cbb.json', '&groups=50&limit=500')
    games = [{**g, 'w': 0.3} for g in prev if g['date'] < cur_start] + [{**g, 'w': 1.0} for g in cur]
    m = ridge_points(games, half_life_days=45, lam=3.0, min_sigma_m=10.5, min_sigma_t=14.0)
    m['locations'] = {}
    for g in games:
        m['locations'][g['home']] = g.get('hloc'); m['locations'][g['away']] = g.get('aloc')
    m['source'] = 'ESPN scoreboard (Division I men)'
    return m


def soc(name):
    # Canonical soccer names so ESPN and openfootball agree: strip FC/AFC, '&' -> 'and'.
    n = (name or '').replace('&', 'and')
    for t in (' AFC', ' FC', 'AFC ', 'FC '):
        n = n.replace(t, ' ') if t.strip() in n.split() else n
    return ' '.join(w for w in n.split() if w not in ('FC', 'AFC'))


def epl():
    matches = []
    try:
        last = json.loads(get('https://raw.githubusercontent.com/openfootball/football.json/master/2025-26/en.1.json'))
        for x in last['matches']:
            sc = x.get('score')
            if isinstance(sc, dict) and sc.get('ft'):
                matches.append({'home': soc(x['team1']), 'away': soc(x['team2']), 'hg': sc['ft'][0], 'ag': sc['ft'][1],
                                'date': dt.date.fromisoformat(x['date']), 'w': 0.5})
    except Exception as e:  # noqa
        print('openfootball fail', e, file=sys.stderr)
    try:
        cur = espn_games('soccer/eng.1', dt.date(2026, 8, 21), TODAY, 'epl.json')
    except RuntimeError:
        cur = []
    for g in cur:
        matches.append({'home': soc(g['home']), 'away': soc(g['away']), 'hg': g['hs'], 'ag': g['as_'], 'date': g['date'], 'w': 1.0})
    m = dixon_coles(matches)
    m['source'] = 'ESPN scoreboard (EPL 2026-27) + openfootball (2025-26)'
    return m


def main():
    prev = json.load(open(OUT)) if os.path.exists(OUT) else {'sports': {}}
    out = {'generatedAt': dt.datetime.now(dt.timezone.utc).replace(microsecond=0, tzinfo=None).isoformat() + 'Z', 'sports': {}}
    for key, fn in [('americanfootball_nfl', nfl), ('americanfootball_ncaaf', cfb), ('basketball_nba', nba),
                    ('basketball_ncaab', cbb), ('soccer_epl', epl)]:
        try:
            m = fn()
            m['updated'] = out['generatedAt']
            out['sports'][key] = m
            print(key, 'ok', m['games'], 'games')
        except Exception as e:  # noqa
            print(key, 'FAILED', repr(e), file=sys.stderr)
            if key in prev.get('sports', {}):
                out['sports'][key] = {**prev['sports'][key], 'stale': True}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, 'w'), separators=(',', ':'))


if __name__ == '__main__':
    main()
