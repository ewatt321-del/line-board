# Line Board

A personal +EV betting dashboard for NFL, college football, NBA, college basketball and the Premier League.
It finds prices at your books that beat the sharp market's no-vig price, sizes each bet with quarter Kelly,
and tracks closing line value (CLV) on every bet you log.

Live page: GitHub Pages for this repo. Everything runs in your browser.

## How it works
- **Odds:** The Odds API, called from your browser with your own key (stored only in localStorage, never in this repo).
  Nothing refreshes on its own unless you turn auto-refresh on; every button shows its credit cost.
  10 books per call cost the same as one region, so a sport refresh costs 3 credits (moneyline, spread, total).
- **Fair value:** Pinnacle's no-vig price (power method by default; Shin or multiplicative selectable).
  If Pinnacle is missing for a market, a weighted no-vig consensus of the other books is used and labelled.
- **EV:** fair probability × decimal odds − 1, after Kalshi's taker fee for Kalshi prices.
- **NFL key numbers:** when your book's line differs from Pinnacle's, the price is moved using real historical
  final-margin and total frequencies (nflverse, 2015–present). Other sports only price a different line when it
  is strictly better for you, and show the EV as a floor.
- **Sizing:** quarter Kelly on the edge vs fair, capped at 2% per bet and 10% per day (editable).
- **CLV:** closing line captured automatically if the page is open near start (1 credit), from any refresh in that
  window (free), or estimated from your last refresh before start ("proxy"). Paid plans can use historical closes.
- **NY rules:** no games involving NY college teams; no college player props (never fetched). Books: the 8 NY-licensed
  apps plus Kalshi (prediction market; NY regulators dispute it). Pinnacle is reference only.
- **Model (second opinion only):** `scripts/build_ratings.py` runs daily in GitHub Actions and writes `data/ratings.json`
  (ridge points ratings for NFL/CFB/NBA/CBB, Dixon-Coles for EPL). It is shown next to each game and never puts a bet on the board.

## Limits
- Free Odds API plan: 500 credits/month, no Fanatics or Caesars prices, no historical odds.
- Injury/lineup news is not pulled automatically: each game has a "check news" flag with official links.
- Sparklines start from the first time this page saw a game, not the true opening line.
- Weather uses the home team's stadium, so it is wrong for neutral-site and international games.
- The bet log lives in this browser (IndexedDB). Use "Back up log" regularly.

## Dev
`npm test` runs the math, pricing and model tests (Node 20+).
