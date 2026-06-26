# S&P 500 Swing Scanner

A Python CLI that scans the S&P 500 for swing-trade buy signals using 5
technical conditions, computed entirely in Python (no paid data APIs —
just `yfinance` and Wikipedia). Every run starts with a market regime check
(SPY/QQQ/IWM/VIX) that gates whether signals are shown at all. Claude Haiku
is only called to produce a trade plan for Grade A+/A/B buy signals
(score >= 65).

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # then add your ANTHROPIC_API_KEY
```

## Usage

```bash
python main.py                          # scan all S&P 500 tickers
python main.py AAPL MSFT NVDA           # scan only these tickers
python main.py --sector "Health Care"   # scan only one GICS sector
python main.py --top 100                # scan only the first N tickers
python main.py --watchlist              # also print the Grade C (55-64) watchlist
python main.py --no-claude              # skip Claude Haiku analysis
python main.py --min-quality 80         # only report signals with score >= 80
python main.py --regime-only            # only print the market regime dashboard
python main.py --force                  # run the scan even in a bear market (testing)
python main.py --regime-threshold 60    # override the min regime score to run (default 55)
```

## Market regime filter

Before scanning any ticker, `analysis/market_regime.py` fetches SPY, QQQ,
IWM, and `^VIX` (1 year, daily, one batched yfinance call) and computes a
0-100 `regime_score` from four indicators:

| Indicator | Max pts | What it measures |
|---|---|---|
| SPY trend | 40 | SPY vs its 50/200 SMA, golden cross, SPY vs 20 EMA |
| VIX fear gauge | 25 | VIX level and whether it's rising or falling |
| Market breadth (IWM) | 20 | Russell 2000 vs its 50/200 SMA and 1-month return |
| Nasdaq health (QQQ) | 15 | QQQ vs its 50/200 SMA and 5-day return |

### Regime classification

| Score | Label | Scan decision |
|---|---|---|
| 85-100 | STRONG BULL ✅✅ | Full scan, can increase position size |
| 70-84 | BULL ✅ | Full scan, normal position sizes |
| 55-69 | WEAK BULL ⚠️ | Scan runs, position size warning (-50%) on every signal |
| 40-54 | NEUTRAL ⚠️ | Scan runs, but buy signals are hidden — watchlist only |
| 25-39 | BEAR ❌ | Scan aborted, no signals shown |
| 0-24 | STRONG BEAR ❌❌ | Scan aborted, consider hedges |

`--regime-threshold` overrides the default 55-point cutoff between
"watchlist only" and "scan runs". The hard abort at score < 40 is fixed.
`--force` runs the scan anyway in a bear market and marks the output as
"FORCED — bear market override". If VIX is above 30, every signal gets a
"VIX ELEVATED — reduce all position sizes" warning regardless of score.

If SPY data can't be fetched, the scanner aborts immediately — it can't run
without a broad-market reference. If VIX, IWM, or QQQ fail individually,
their score falls back to a documented default (VIX 12/25, breadth 10/20,
Nasdaq 7/15) and a warning is printed.

## Scoring (0-100)

Each result is scored 0-100 across 5 conditions. C1 and C2 are hard trend
gates — scoring 0 on either forces the total score to 0 regardless of
C3-C5. C3-C5 award partial credit on a sliding scale.

| # | Condition | Max pts | What it measures |
|---|-----------|---------|------------------|
| C1 | 10 EMA vs 20 EMA gap | 25 | Short-term momentum strength (hard gate: 0 pts if 10 EMA < 20 EMA) |
| C2 | Price vs 50 EMA | 20 | Medium-term uptrend strength (hard gate: 0 pts if price < 50 EMA) |
| C3 | MACD line vs signal line | 25 | Whether MACD is in a bullish (buy) or bearish (sell) state |
| C4 | RSI zone | 15 | Room to run before overbought |
| C5 | Volume accumulation phase | 15 | Conviction behind the move (OBV, A/D line, CMF, up/down volume) |

### C1 — 10/20 EMA gap (0-25, hard gate)

`ema_gap_pct = (ema10 - ema20) / ema20 * 100`

| ema_gap_pct | Points |
|---|---|
| ema10 < ema20 | 0 (hard gate — skip) |
| > 1.0% | 25 |
| 0.5-1.0% | 22 |
| 0-0.5% | 18 |

### C2 — price vs 50 EMA (0-20, hard gate)

`pct_above = (price - ema50) / ema50 * 100`

| pct_above | Points |
|---|---|
| price < ema50 | 0 (hard gate — skip) |
| > 5% | 20 |
| 2-5% | 18 |
| 0-2% | 15 |

### C3 — MACD buy/sell (0-25)

A simple read of the standard 12/26/9 MACD: if the MACD line is above its
signal line, that's a "buy" state; if it's below, that's a "sell" state.

| MACD vs signal | Points |
|---|---|
| MACD line > signal line (BUY) | 25 |
| MACD line <= signal line (SELL) | 0 |

### C4 — RSI zone (0-15)

| RSI | Points |
|---|---|
| >= 70 | 0 |
| 63-70 | 10 |
| 40-63 | 15 |
| 35-40 | 11 |
| < 35 | 6 |

### C5 — volume accumulation/distribution phase (0-15)

`analysis/volume_accumulation.py` combines four volume indicators into a
0-100 "accumulation score" (`acc_score`), which is then converted into C5
points:

| acc_score | Phase | C5 Points |
|---|---|---|
| >= 75 | STRONG ACCUMULATION ✅✅ | 15 |
| >= 50 | ACCUMULATION ✅ | 12 |
| >= 30 | MILD ACCUMULATION ⚠️ | 8 |
| >= 15 | NEUTRAL | 4 |
| < 15 | DISTRIBUTION ❌ | 0 |

`acc_score` is the sum of four sub-scores (clamped to 0-100):

| Indicator | Points | What it measures |
|---|---|---|
| OBV (On Balance Volume) | 0-30 | New 20-day high, or rising above its 20-day average |
| A/D Line | 0-30 | Rising accumulation/distribution line, or bullish divergence vs price |
| CMF (Chaikin Money Flow, 20d) | -10 to 25 | Money flow strength; negative CMF penalizes distribution |
| Up/Down volume ratio (10d) | 0-15 | Ratio of average volume on up days vs down days |

If a stock has zero total volume (e.g. a halted ticker), accumulation
scoring is skipped entirely and C5 is awarded a flat 4 points.

The single-day `volume_ratio` (vs 20-day average) is still computed and
shown for reference/CSV, and used as a secondary sort key (after score) when
ranking signals.

## Signal grades

| Score | Grade | Signal | Claude review | Position size |
|---|---|---|---|---|
| 85-100 | A+ | STRONG BUY | Yes (full size) | 100% |
| 75-84 | A | BUY | Yes (full size) | 100% |
| 65-74 | B | WEAK BUY | Yes (half size) | 50% |
| 55-64 | C | WATCH | No | 0% (watchlist only) |
| 0-54 | D/F | SKIP | No | 0% |

`--min-quality` filters the final report and `signals_{date}.csv` to signals
with `score >=` that value.

## Output

- Market regime dashboard (printed first, before any ticker is scanned),
  showing the score breakdown for SPY trend, VIX, breadth, and Nasdaq health
- Live per-ticker progress showing grade, signal label, and score
  (✅ A+/A, ⚠️ B, 👁 C, ❌ D/F) plus running progress summaries
- Final report header includes the regime score and SPY/VIX/IWM/QQQ status
- Grade A+/A/B buy signals ranked by score, each with a per-condition score
  bar, a volume accumulation breakdown (OBV, A/D line, CMF, up/down volume,
  phase), Claude trade plan, and regime score; Grade C watchlist, sector
  breakdown, MACD buy/sell breakdown, and estimated Claude API cost
- In a WEAK BULL regime, every signal gets a position-size warning
  (reduce size 50%, tighter stops, earlier profit-taking)
- CSV exports after every scan: `signals_{date}.csv`, `watchlist_{date}.csv`,
  `full_scan_{date}.csv` (each row also carries a regime snapshot), and
  `regime_log_{date}.csv` — one row per run, appended over time to track
  regime changes
