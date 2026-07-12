"""Fair-value estimation for one ticker, built entirely from data already
free-tier-available across this repo's existing providers — no new paid
data source. Several independent angles, deliberately never blended into
one number (each measures something different; averaging them would hide
which one is actually doing the work):

  1. Method A — sector-relative: this ticker's own trailing fundamental
     (net income, FCF, revenue, book value, EBITDA — whichever the
     ticker's GICS sector maps to, see SECTOR_MULTIPLE_MAP) x the median
     of that same multiple across every other S&P 500 / Nasdaq 100
     constituent in its sector (sector_benchmark.py). Median, not mean —
     multiples are right-skewed and a single 200x-P/E name would distort
     a mean badly (confirmed live: Energy sector, FANG's 206.78 P/E vs.
     a correctly-resistant 18.7 median).
  2. Method B — own-history reversion: this SAME ticker's own multiple,
     averaged over its own recent past, applied to its current
     fundamental. Originally scoped for a 5y/10y/max lookback, but
     capped to ~13 months — see DESIGN NOTE below, this is a real data
     ceiling, not an arbitrary choice.
  3. FCF yield/trend — free cash flow (operating cash flow - capex) from
     Finnhub's SEC-EDGAR-sourced annual statements, compared against the
     ticker's OWN multi-year FCF-yield history relative to TODAY's
     market cap (not a "reversion" claim — see its own docstring below).
  4. Relative multiples — P/E, Forward P/E, PEG, P/S, P/B, P/FCF,
     EV/EBITDA, ROE/ROA/ROIC, margins, Debt/Eq, from Finviz + Finnhub.
     Shown as CONTEXT alongside Methods A/B, not a competing fair-value
     number.
  5. 52-week range context — current price vs. Alpaca-derived 52-week
     high/low. A mean-reversion sanity check, not a valuation method.

Plus analyst sentiment (Finnhub /stock/recommendation — buy/hold/sell
counts, NOT a price: confirmed live that /stock/price-target 403s on the
free tier, and Finviz's current snapshot table no longer has a Target
Price field either — there is no free analyst price-target source across
any provider this repo has access to).

DESIGN NOTE — why Method B is capped at ~13 months, not 5y/10y/max:
confirmed live against production (AAPL, requesting 3650 days of daily
bars) that Alpaca's free/paper tier (feed=iex) only returns ~274 candles
of real history, spanning ~13 months — not the years of price history the
original 5y/10y/max lookback design assumed. A "5-year own-history
multiple" needs 5 years of REAL price matched to REAL point-in-time
fundamentals; that price data doesn't exist for free anywhere this app is
wired up to. The window is capped to whatever Alpaca actually has, and
labeled honestly (windowStart/windowEnd in the output) rather than
claiming a longer lookback than the data supports.

DESIGN NOTE — why Method B needs quarterly TTM reconstruction, not just
"today's fundamental": if the same fundamental value were divided into
prices sampled across the window, the fundamental cancels out of the
average multiple entirely (own_avg_multiple = avg(price)/constant, and
multiplying back by that same constant just reproduces avg(price)) — a
circular, meaningless "fair value." The fundamental has to actually vary
across the window for this to mean anything, which means reconstructing
trailing-twelve-month figures at each of several real points in time from
Finnhub's quarterly filings (see _discrete_quarterly_series below) rather
than reusing one static "latest" figure.

DESIGN NOTE — why FCF yield/trend (separate from Method B) is "most
recent full fiscal year vs. TODAY's market cap," not trailing twelve
months matched to historical price: confirmed live that Finnhub's
"quarterly" filings report cumulative fiscal-year-to-date figures
(standard 10-Q practice), not discrete quarters — e.g. AAPL's Q1/Q2
operating cash flow for the same fiscal year were $29.9B then $82.6B, the
second including the first, not a separate figure. This is the same
cumulative-vs-discrete problem Method B's reconstruction solves properly;
FCF yield/trend predates that work and intentionally keeps its simpler,
already-shipped methodology (today's market cap against each historical
year's FCF) rather than being silently redefined out from under a UI
that's already reading its exact shape. It measures something different
from Method B anyway: "has this company's own cash generation trended up
or down, priced at what the market pays for it today," not "would this
stock's price revert to its own historical valuation."

Data map (which field comes from where):
  Alpaca  (data.py::get_daily_bars)        -> 52w high/low, current price,
                                               Method B's real matched
                                               daily prices (~13mo depth)
  Finnhub (finnhub_client.py):
    /stock/financials-reported (annual)    -> revenue, net income,
                                               operating cash flow, capex,
                                               diluted shares (FCF yield
                                               trend, Method A's current
                                               fundamentals)
    /stock/financials-reported (quarterly) -> same concepts, reconstructed
                                               from cumulative FYTD to
                                               discrete-quarter to TTM
                                               (Method B only)
    /stock/metric?metric=all               -> PEG, market cap, beta, ROE,
                                               margins, debt/equity,
                                               book value/share, enterprise
                                               value, EV/EBITDA (Method A's
                                               P/B and EV/EBITDA sectors)
    /stock/recommendation                  -> analyst buy/hold/sell trend
  Finviz  (finviz_snapshot.py)             -> P/E, Forward P/E, P/S, P/B,
                                               P/FCF, EV/EBITDA, ROA, ROIC,
                                               52W High/Low (cross-check),
                                               Debt/Eq, margins (peer
                                               scraping for Method A is
                                               sector_benchmark.py, same
                                               parser)
  Wikipedia (via backend/data/export_universe.mjs -> swing_scanner/data/)
                                            -> GICS sector classification,
                                               sector_universe.py
"""
from __future__ import annotations

from dataclasses import dataclass

from datetime import date, datetime

import pandas as pd

from data import get_daily_bars
from finnhub_client import get_basic_financials, get_financials_reported, get_recommendation_trend
from finviz_snapshot import parse_snapshot_table
from sector_benchmark import MIN_PEERS_FOR_CONFIDENCE, compute_sector_medians, get_sector_peer_data
from sector_universe import get_sector

MIN_ANNUAL_YEARS_FOR_TREND = 3   # fewer than this and a CAGR is more noise than signal
STALE_ANNUAL_DATA_DAYS = 400     # most recent fiscal year-end older than this -> flag it
FCF_YIELD_HISTORY_YEARS = 5      # how many years back to compute the "own history" FCF yield range
LOW_LIQUIDITY_AVG_VOLUME = 100_000  # 20-day avg volume below this -> current price is a less trustworthy anchor
MIN_TTM_POINTS_OWN_HISTORY = 3   # fewer real (date, multiple) points than this and an "own average" is mostly noise

# GICS sector -> which multiple(s) Method A computes for that sector, using
# the real sector labels Wikipedia's table returns (confirmed live:
# "Health Care" not "Healthcare", "Information Technology" not
# "Technology", "Real Estate" not "Real Estate/REITs"). Shown to and
# confirmed with the user before implementation. "roe" is context
# alongside Financials' P/B, never itself multiplied into a price — same
# treatment ROE already gets in _multiples_context.
SECTOR_MULTIPLE_MAP = {
    "Industrials": ["evToEbitda"],
    "Financials": ["priceToBook", "roe"],
    "Information Technology": ["priceToSales", "priceToFcf"],
    "Health Care": ["peTrailing", "priceToFcf"],
    "Consumer Discretionary": ["peTrailing", "priceToFcf"],
    "Consumer Staples": ["peTrailing", "priceToFcf"],
    "Utilities": ["peTrailing"],
    "Real Estate": ["priceToFcf"],
    "Materials": ["evToEbitda"],
    "Communication Services": ["peTrailing", "evToEbitda"],
    "Energy": ["evToEbitda"],
}

# What each multiple's per-share base actually is — only used to name the
# guard reason when that base is negative (see _compute_method_a).
MULTIPLE_BASE_LABELS = {
    "peTrailing": "net income",
    "priceToSales": "revenue",
    "priceToFcf": "FCF",
    "priceToBook": "book value",
}

# XBRL concept tags, in priority order — confirmed live against both AAPL
# (large-cap, "clean" tagging) and SATS (thin-coverage, different tagging
# style entirely) to make sure this isn't tuned to one filer's habits.
CONCEPT_CANDIDATES = {
    "revenue": [
        "us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax",
        "us-gaap_RevenueFromContractWithCustomerIncludingAssessedTax",
        "us-gaap_Revenues",
        "us-gaap_SalesRevenueNet",
    ],
    "net_income": [
        "us-gaap_NetIncomeLoss",
        "us-gaap_ProfitLoss",
        "us-gaap_NetIncomeLossAvailableToCommonStockholdersBasic",
    ],
    "operating_cash_flow": [
        "us-gaap_NetCashProvidedByUsedInOperatingActivities",
        "us-gaap_NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    "capex": [
        "us-gaap_PaymentsToAcquirePropertyPlantAndEquipment",
        "us-gaap_PaymentsForCapitalImprovements",
        "us-gaap_PaymentsToAcquireProductiveAssets",
    ],
    "diluted_shares": [
        "us-gaap_WeightedAverageNumberOfDilutedSharesOutstanding",
    ],
    "basic_shares": [
        "us-gaap_WeightedAverageNumberOfSharesOutstandingBasic",
    ],
    # Debt/cash are best-effort only — concept naming varies more here than
    # any other line item (AAPL uses LongTermDebtCurrent/Noncurrent; SATS
    # uses a completely different LongTermDebtAndCapitalLeaseObligations*
    # pair) — summed across every matching concept present, since filers
    # split these into current/noncurrent components rather than reporting
    # one total. (Not currently used by Method A's EV/EBITDA — that uses
    # Finnhub's own enterpriseValue/evEbitdaTTM instead, see
    # _compute_method_a — kept here for the total_debt/cash context fields
    # a future extension might want.)
    "total_debt": [
        "us-gaap_LongTermDebtNoncurrent",
        "us-gaap_LongTermDebtCurrent",
        "us-gaap_LongTermDebtAndCapitalLeaseObligations",
        "us-gaap_LongTermDebtAndCapitalLeaseObligationsCurrent",
    ],
    "cash_and_equivalents": [
        "us-gaap_CashAndCashEquivalentsAtCarryingValue",
    ],
}


def _find_concept_value(items: list[dict], candidates: list[str]) -> float | None:
    """First matching concept, checked in priority order — for figures
    that should appear as exactly one line item (revenue, net income,
    etc.). None if no candidate concept is present in this filing."""
    by_concept = {}
    for item in items:
        concept = item.get("concept")
        if concept and concept not in by_concept and item.get("value") is not None:
            by_concept[concept] = item["value"]
    for concept in candidates:
        if concept in by_concept:
            return float(by_concept[concept])
    return None


@dataclass
class AnnualFigures:
    year: int
    end_date: str
    revenue: float | None
    net_income: float | None
    operating_cash_flow: float | None
    capex: float | None
    fcf: float | None
    diluted_shares: float | None


def _extract_annual_figures(filing: dict) -> AnnualFigures | None:
    report = filing.get("report") or {}
    ic, cf = report.get("ic") or [], report.get("cf") or []
    if not ic and not cf:
        return None

    ocf = _find_concept_value(cf, CONCEPT_CANDIDATES["operating_cash_flow"])
    capex = _find_concept_value(cf, CONCEPT_CANDIDATES["capex"])
    fcf = ocf - capex if ocf is not None and capex is not None else None
    diluted_shares = (
        _find_concept_value(ic, CONCEPT_CANDIDATES["diluted_shares"])
        or _find_concept_value(ic, CONCEPT_CANDIDATES["basic_shares"])  # fallback if diluted isn't reported
    )

    return AnnualFigures(
        year=filing.get("year"),
        end_date=(filing.get("endDate") or "")[:10],
        revenue=_find_concept_value(ic, CONCEPT_CANDIDATES["revenue"]),
        net_income=_find_concept_value(ic, CONCEPT_CANDIDATES["net_income"]),
        operating_cash_flow=ocf,
        capex=capex,
        fcf=fcf,
        diluted_shares=diluted_shares,
    )


def _extract_all_annual_figures(annual_filings: list[dict]) -> list[AnnualFigures]:
    figures = [f for f in (_extract_annual_figures(filing) for filing in annual_filings) if f is not None]
    figures.sort(key=lambda f: f.end_date, reverse=True)
    return figures


def _cagr(first: float, last: float, years: int) -> float | None:
    if first is None or last is None or years <= 0 or first <= 0 or last <= 0:
        return None  # a negative-to-positive (or vice versa) swing has no meaningful CAGR
    return (last / first) ** (1 / years) - 1


def _pct(value: str) -> float | None:
    if not value or value in ("-", "N/A"):
        return None
    try:
        return float(value.replace("%", "").replace(",", ""))
    except ValueError:
        return None


def _num(value: str) -> float | None:
    if not value or value in ("-", "N/A"):
        return None
    suffix_mult = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}
    mult = suffix_mult.get(value[-1].upper()) if value[-1].isalpha() else None
    try:
        return float(value[:-1] if mult else value.replace(",", "")) * (mult or 1)
    except ValueError:
        return None


def _compute_fcf_yield_trend(figures: list[AnnualFigures], market_cap: float | None) -> dict:
    figures = [f for f in figures if f.fcf is not None]

    if not figures:
        return {"available": False, "reason": "No usable FCF figures found in reported financials"}

    latest = figures[0]
    history = figures[:FCF_YIELD_HISTORY_YEARS]

    latest_yield = (latest.fcf / market_cap * 100) if market_cap else None
    yields = [(f.fcf / market_cap * 100) for f in history if market_cap] if market_cap else []
    avg_yield = sum(yields) / len(yields) if yields else None

    trend = None
    if len(figures) >= MIN_ANNUAL_YEARS_FOR_TREND:
        oldest_in_window = figures[min(FCF_YIELD_HISTORY_YEARS, len(figures)) - 1]
        years_span = int(latest.year) - int(oldest_in_window.year)
        trend = _cagr(oldest_in_window.fcf, latest.fcf, years_span) if years_span > 0 else None

    return {
        "available": True,
        "asOfFiscalYear": latest.year,
        "asOfDate": latest.end_date,
        "fcf": latest.fcf,
        "operatingCashFlow": latest.operating_cash_flow,
        "capex": latest.capex,
        "fcfYieldPct": round(latest_yield, 2) if latest_yield is not None else None,
        "ownHistoryAvgYieldPct": round(avg_yield, 2) if avg_yield is not None else None,
        "yieldVsOwnHistory": (
            "above_average" if latest_yield is not None and avg_yield is not None and latest_yield > avg_yield
            else "below_average" if latest_yield is not None and avg_yield is not None
            else None
        ),
        "fcfCagrPct": round(trend * 100, 2) if trend is not None else None,
        "yearsOfHistory": len(figures),
    }


# ---------------------------------------------------------------------------
# Method B: own-history reversion via quarterly TTM reconstruction
# ---------------------------------------------------------------------------

def _cumulative_value(filing: dict, section: str, candidates: list[str]) -> float | None:
    report = filing.get("report") or {}
    return _find_concept_value(report.get(section) or [], candidates)


def _fiscal_cohort(filing: dict) -> tuple:
    # Finnhub's quarterly filings for the same fiscal year all share the
    # same `startDate` (the fiscal year's start) — confirmed live on AAPL
    # (FY2026 Q1 and Q2 both have startDate 2025-09-28) — that's what
    # identifies "these cumulative figures accumulate together."
    return (filing.get("year"), (filing.get("startDate") or "")[:10])


def _discrete_quarterly_series(
    quarterly_filings: list[dict], annual_filings: list[dict], section: str, candidates: list[str]
) -> list[tuple[str, float]]:
    """[(end_date, discrete_quarter_value), ...] ascending by date,
    reconstructed from Finnhub's cumulative fiscal-year-to-date quarterly
    figures (see module docstring's DESIGN NOTE). Q1's cumulative value IS
    the discrete value; Q2/Q3 are diffed against the prior cumulative
    filing in the same fiscal-year cohort; Q4 isn't filed as its own 10-Q
    (folded into the 10-K) so it's back-solved as annual_total -
    cumulative_Q3. A quarter is silently skipped (not filled with a
    guess) if its constituent cumulative values aren't present — a
    shorter reconstructed series is preferable to a fabricated point."""
    by_cohort: dict[tuple, dict[int, dict]] = {}
    for f in quarterly_filings:
        by_cohort.setdefault(_fiscal_cohort(f), {})[f.get("quarter")] = f

    annual_by_year = {f.get("year"): f for f in annual_filings}

    series: list[tuple[str, float]] = []
    for (year, _start), quarters in by_cohort.items():
        cum = {q: _cumulative_value(filing, section, candidates) for q, filing in quarters.items()}

        discrete: dict[int, float] = {}
        if cum.get(1) is not None:
            discrete[1] = cum[1]
        if cum.get(2) is not None and cum.get(1) is not None:
            discrete[2] = cum[2] - cum[1]
        if cum.get(3) is not None and cum.get(2) is not None:
            discrete[3] = cum[3] - cum[2]

        annual = annual_by_year.get(year)
        if annual is not None and cum.get(3) is not None:
            annual_total = _cumulative_value(annual, section, candidates)
            if annual_total is not None:
                discrete[4] = annual_total - cum[3]

        for q, value in discrete.items():
            filing = quarters.get(q) or annual
            end_date = (filing.get("endDate") or "")[:10] if filing else None
            if end_date:
                series.append((end_date, value))

    series.sort(key=lambda row: row[0])
    return series


def _ttm_series(discrete_series: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """[(end_date, trailing_twelve_month_value), ...] via a trailing
    4-quarter sliding sum over consecutive discrete quarters. Requires at
    least 4 discrete points before it can produce its first TTM point."""
    return [
        (discrete_series[i][0], sum(v for _, v in discrete_series[i - 3:i + 1]))
        for i in range(3, len(discrete_series))
    ]


def _shares_series(quarterly_filings: list[dict]) -> list[tuple[str, float]]:
    series = []
    for f in quarterly_filings:
        ic = (f.get("report") or {}).get("ic") or []
        shares = (
            _find_concept_value(ic, CONCEPT_CANDIDATES["diluted_shares"])
            or _find_concept_value(ic, CONCEPT_CANDIDATES["basic_shares"])
        )
        end_date = (f.get("endDate") or "")[:10]
        if shares and end_date:
            series.append((end_date, shares))
    series.sort(key=lambda row: row[0])
    return series


def _nearest_at_or_before(series: list[tuple[str, float]], target_date: str) -> float | None:
    before = [v for d, v in series if d <= target_date]
    if before:
        return before[-1]
    return series[0][1] if series else None  # nothing at/before target — fall back to earliest known rather than None


def _per_share_ttm_series(
    ttm_values: list[tuple[str, float]], shares_series: list[tuple[str, float]]
) -> list[tuple[str, float]]:
    result = []
    for end_date, value in ttm_values:
        shares = _nearest_at_or_before(shares_series, end_date)
        if shares:
            result.append((end_date, value / shares))
    return result


def _own_history_multiple(per_share_series: list[tuple[str, float]], bars) -> dict:
    """Matches each reconstructed TTM-per-share point against Alpaca's
    REAL closing price on or immediately before that date (never a future
    price relative to the fundamental it's paired with), averages the
    resulting multiple across however many points Alpaca's ~13-month
    depth actually allows, then applies that own-average multiple to the
    latest per-share fundamental. windowStart/windowEnd report exactly
    what span was used — never claims a longer lookback than the points
    it actually had."""
    if bars is None or len(bars) == 0 or not per_share_series:
        return {"available": False, "reason": "No price or fundamental history available"}

    closes = bars["c"]
    points = []
    for end_date, per_share in per_share_series:
        if per_share is None or per_share <= 0:
            continue
        # bars' index is tz-aware UTC (Alpaca returns ISO8601 timestamps
        # with a Z suffix; pd.to_datetime keeps that tz in data.py), but a
        # plain "YYYY-MM-DD" string parses to a tz-naive Timestamp —
        # comparing the two raises "Invalid comparison between
        # dtype=datetime64[ns, UTC] and Timestamp" (confirmed live).
        ts = pd.Timestamp(end_date, tz="UTC")
        prior = closes[closes.index <= ts]
        if prior.empty:
            continue  # this TTM point predates Alpaca's available price history — skip rather than fabricate
        price = float(prior.iloc[-1])
        points.append((end_date, price / per_share))

    if len(points) < MIN_TTM_POINTS_OWN_HISTORY:
        return {
            "available": False,
            "reason": f"Only {len(points)} real (price, fundamental) point(s) within Alpaca's available history "
                      f"— need at least {MIN_TTM_POINTS_OWN_HISTORY} for an own-average multiple to mean anything",
        }

    own_avg_multiple = sum(m for _, m in points) / len(points)
    latest_per_share = per_share_series[-1][1]
    current_multiple = points[-1][1]
    # A negative latest fundamental (e.g. a current TTM loss) times a
    # positive own-average multiple produces a negative "fair value,"
    # which isn't meaningful — same guard as Method A's negative-base
    # check (confirmed live there via SATS; withheld here for the same
    # reason rather than shown as a real number).
    implied_fair_value = latest_per_share * own_avg_multiple if latest_per_share and latest_per_share > 0 else None

    return {
        "available": True,
        "ownAvgMultiple": round(own_avg_multiple, 2),
        "currentMultiple": round(current_multiple, 2),
        "impliedFairValue": round(implied_fair_value, 2) if implied_fair_value is not None else None,
        "pointsUsed": len(points),
        "windowStart": points[0][0],
        "windowEnd": points[-1][0],
    }


def _week_range_context(bars) -> dict:
    # `bars is None` means the fetch itself failed (auth/network/no data at
    # all for this symbol) — distinct from "fetched fine, but this ticker
    # trades thin" (avgVolume20, checked by the caller). Conflating those
    # two into one flag would hide a real infra problem behind what looks
    # like a per-ticker data-quality note — same distinction already made
    # for earnings fetch failures vs. confirmed-no-data (see
    # earningsProvider.js).
    if bars is None or len(bars) == 0:
        return {"available": False, "fetchFailed": True}
    highs, lows, closes, volumes = bars["h"], bars["l"], bars["c"], bars["v"]
    high_52w, low_52w = float(highs.max()), float(lows.min())
    price = float(closes.iloc[-1])
    pct_from_high = (price - high_52w) / high_52w * 100
    pct_from_low = (price - low_52w) / low_52w * 100
    avg_volume_20 = float(volumes.tail(20).mean())
    return {
        "available": True,
        "fetchFailed": False,
        "price": round(price, 2),
        "high52w": round(high_52w, 2),
        "low52w": round(low_52w, 2),
        "pctFromHigh": round(pct_from_high, 2),
        "pctFromLow": round(pct_from_low, 2),
        "avgVolume20": round(avg_volume_20),
    }


def _sane_peg(value) -> float | None:
    """PEG is undefined for negative earnings/growth — Finnhub's pegTTM
    returns a near-zero or negative float in that case rather than null
    (confirmed live on SATS: -0.00035), which looks like real data but
    isn't a meaningful ratio. A negative PEG is filtered out; Finviz's own
    PEG field already shows "-" (parses to None via _num) for the same
    case, so this only matters for the Finnhub fallback."""
    return value if isinstance(value, (int, float)) and value > 0 else None


def _multiples_context(finviz_snapshot: dict, finnhub_metrics: dict) -> dict:
    return {
        "peTrailing": _num(finviz_snapshot.get("P/E", "")),
        "peForward": _num(finviz_snapshot.get("Forward P/E", "")),
        "peg": _num(finviz_snapshot.get("PEG", "")) or _sane_peg(finnhub_metrics.get("pegTTM")),
        "priceToSales": _num(finviz_snapshot.get("P/S", "")),
        "priceToBook": _num(finviz_snapshot.get("P/B", "")),
        "priceToFcf": _num(finviz_snapshot.get("P/FCF", "")),
        "evToEbitda": _num(finviz_snapshot.get("EV/EBITDA", "")),
        "debtToEquity": _num(finviz_snapshot.get("Debt/Eq", "")),
        "roe": _pct(finviz_snapshot.get("ROE", "")),
        "roa": _pct(finviz_snapshot.get("ROA", "")),
        "roic": _pct(finviz_snapshot.get("ROIC", "")),
        "grossMarginPct": _pct(finviz_snapshot.get("Gross Margin", "")),
        "operatingMarginPct": _pct(finviz_snapshot.get("Oper. Margin", "")),
        "profitMarginPct": _pct(finviz_snapshot.get("Profit Margin", "")),
        "note": "Context only — see methodA for this ticker's own sector-relative fair-value estimate.",
    }


def _analyst_sentiment(recommendations: list[dict]) -> dict:
    if not recommendations:
        return {"available": False}
    latest = recommendations[0]
    return {
        "available": True,
        "period": latest.get("period"),
        "strongBuy": latest.get("strongBuy"),
        "buy": latest.get("buy"),
        "hold": latest.get("hold"),
        "sell": latest.get("sell"),
        "strongSell": latest.get("strongSell"),
        "note": "Analyst sentiment (rating counts), not a price target — no free price-target source exists "
                "across any provider this app uses (Finnhub's /stock/price-target is premium-only, confirmed "
                "live; Finviz's snapshot table no longer has a Target Price field).",
    }


# ---------------------------------------------------------------------------
# Method A: sector-relative fair value
# ---------------------------------------------------------------------------

def _compute_method_a(
    sector: str | None,
    ticker: str,
    current_price: float | None,
    market_cap: float | None,
    finnhub_metrics: dict,
    net_income_per_share: float | None,
    revenue_per_share: float | None,
    fcf_per_share: float | None,
) -> dict:
    if sector is None:
        return {"available": False, "reason": "Ticker not in the S&P 500 / Nasdaq 100 sector universe this app tracks"}

    fields = SECTOR_MULTIPLE_MAP.get(sector)
    if not fields:
        return {"available": False, "reason": f"No multiple mapping configured for sector '{sector}'"}

    peer_data = get_sector_peer_data(sector)
    medians = compute_sector_medians(peer_data, exclude_ticker=ticker)

    # EV/EBITDA and P/B don't need new XBRL concept extraction — Finnhub's
    # /stock/metric payload already carries bookValuePerShare and
    # enterpriseValue/evEbitdaTTM, confirmed live (AAPL:
    # bookValuePerShareQuarterly=7.26, enterpriseValue=4,670,356.5M,
    # evEbitdaTTM=29.19) — own EBITDA is backed out as
    # enterpriseValue / evEbitdaTTM rather than reconstructed from
    # depreciation/interest/tax XBRL concepts this app doesn't otherwise need.
    book_value_per_share = finnhub_metrics.get("bookValuePerShareQuarterly") or finnhub_metrics.get("bookValuePerShareAnnual")
    enterprise_value = finnhub_metrics.get("enterpriseValue")
    ev_ebitda_ttm = finnhub_metrics.get("evEbitdaTTM")
    enterprise_value = enterprise_value * 1e6 if isinstance(enterprise_value, (int, float)) else None
    own_ebitda = (enterprise_value / ev_ebitda_ttm) if enterprise_value and ev_ebitda_ttm else None
    net_debt = (enterprise_value - market_cap) if enterprise_value is not None and market_cap is not None else None
    shares_outstanding = (market_cap / current_price) if market_cap and current_price else None

    per_share_base = {
        "peTrailing": net_income_per_share,
        "priceToSales": revenue_per_share,
        "priceToFcf": fcf_per_share,
        "priceToBook": book_value_per_share,
    }

    low_confidence_any = False
    results = {}
    for field in fields:
        info = medians.get(field, {})
        peer_median = info.get("median")
        peer_count = info.get("peerCount", 0)
        low_confidence = peer_count < MIN_PEERS_FOR_CONFIDENCE
        low_confidence_any = low_confidence_any or (low_confidence and peer_count > 0)

        entry = {"peerMedian": peer_median, "peerCount": peer_count, "lowConfidence": low_confidence}

        if field == "roe":
            # Context alongside Financials' P/B, never itself turned into a
            # price — same treatment ROE gets in _multiples_context.
            results[field] = entry
            continue

        implied_value = None
        if field == "evToEbitda":
            # A negative own_ebitda (confirmed live possible via Finnhub's
            # evEbitdaTTM) makes "own_ebitda x positive peer multiple" a
            # negative EV, which produces a nonsensical negative "fair
            # value" — same class of bug as a negative PEG (_sane_peg) or a
            # negative P/E base below. Skipped, not shown as a number.
            if peer_median is not None and own_ebitda is not None and own_ebitda > 0 and net_debt is not None and shares_outstanding:
                implied_equity_value = own_ebitda * peer_median - net_debt
                implied_value = implied_equity_value / shares_outstanding
            elif own_ebitda is not None and own_ebitda <= 0:
                entry["reason"] = "Negative TTM EBITDA — no meaningful EV/EBITDA-implied value"
        else:
            base = per_share_base.get(field)
            # A negative fundamental (e.g. a net loss) times a positive
            # peer multiple produces a negative "fair value," which isn't
            # meaningful (confirmed live: SATS' negative net income gave a
            # -$1,110 "implied" P/E fair value before this guard) —
            # withheld rather than shown as a real number, same spirit as
            # PEG's negative-value guard (_sane_peg).
            if peer_median is not None and base is not None and base > 0:
                implied_value = base * peer_median
            elif base is not None and base <= 0:
                entry["reason"] = f"Negative {MULTIPLE_BASE_LABELS.get(field, 'fundamental')} — no meaningful implied value"

        entry["impliedFairValue"] = round(implied_value, 2) if implied_value is not None else None
        entry["pctFromCurrentPrice"] = (
            round((implied_value - current_price) / current_price * 100, 2)
            if implied_value is not None and current_price else None
        )
        results[field] = entry

    return {
        "available": True,
        "sector": sector,
        "peerUniverseSize": len(peer_data),
        "multiples": results,
        "lowConfidence": low_confidence_any,
    }


def get_fair_value(ticker: str) -> dict:
    ticker = ticker.upper()
    flags: list[str] = []

    bars = get_daily_bars(ticker, lookback_days=400)
    week_range = _week_range_context(bars)
    if week_range.get("fetchFailed"):
        flags.append("PRICE_DATA_UNAVAILABLE")
    elif week_range.get("avgVolume20") is not None and week_range["avgVolume20"] < LOW_LIQUIDITY_AVG_VOLUME:
        flags.append("LOW_LIQUIDITY")
    current_price = week_range.get("price")

    annual_filings = get_financials_reported(ticker, freq="annual")
    if not annual_filings:
        flags.append("MISSING_FINANCIALS")
    elif len(annual_filings) < MIN_ANNUAL_YEARS_FOR_TREND:
        flags.append("THIN_HISTORY")

    finnhub_metrics = get_basic_financials(ticker)
    market_cap = finnhub_metrics.get("marketCapitalization")
    market_cap = market_cap * 1e6 if isinstance(market_cap, (int, float)) else None

    figures = _extract_all_annual_figures(annual_filings) if annual_filings else []
    latest_annual = figures[0] if figures else None

    if figures:
        fcf_yield_trend = _compute_fcf_yield_trend(figures, market_cap)
        # The latest filing exists but none of this metric's known XBRL
        # concept variants matched anything in it — a real filer-specific
        # tagging gap, not "no data at all" (MISSING_FINANCIALS), so it
        # gets its own flag rather than looking like the same problem.
        if not fcf_yield_trend.get("available"):
            flags.append("CONCEPT_MISMATCH")
        else:
            if fcf_yield_trend.get("asOfDate"):
                age_days = (date.today() - datetime.strptime(fcf_yield_trend["asOfDate"], "%Y-%m-%d").date()).days
                if age_days > STALE_ANNUAL_DATA_DAYS:
                    flags.append("STALE_ANNUAL_DATA")
            if fcf_yield_trend.get("fcfCagrPct") is None:
                flags.append("INSUFFICIENT_TREND_DATA")
    else:
        fcf_yield_trend = {"available": False, "reason": "No annual financial statements found"}

    # Method A: current per-share fundamentals come from the latest ANNUAL
    # filing (already-tested extraction, same figures FCF yield/trend
    # uses) — no need for quarterly reconstruction here, only Method B's
    # multi-point own-history average needs that.
    net_income_per_share = (
        latest_annual.net_income / latest_annual.diluted_shares
        if latest_annual and latest_annual.net_income and latest_annual.diluted_shares else None
    )
    revenue_per_share = (
        latest_annual.revenue / latest_annual.diluted_shares
        if latest_annual and latest_annual.revenue and latest_annual.diluted_shares else None
    )
    fcf_per_share = (
        latest_annual.fcf / latest_annual.diluted_shares
        if latest_annual and latest_annual.fcf and latest_annual.diluted_shares else None
    )

    sector = get_sector(ticker)
    method_a = _compute_method_a(
        sector, ticker, current_price, market_cap, finnhub_metrics,
        net_income_per_share, revenue_per_share, fcf_per_share,
    )
    if method_a.get("lowConfidence"):
        flags.append("LOW_CONFIDENCE_PEER_GROUP")

    # Method B: needs multiple real point-in-time fundamentals, which
    # requires quarterly TTM reconstruction (annual filings only give ~1-2
    # points within Alpaca's ~13-month price window — not enough for an
    # "own average" to mean anything).
    quarterly_filings = get_financials_reported(ticker, freq="quarterly") if annual_filings else []
    shares_series = _shares_series(quarterly_filings)

    net_income_ttm = _ttm_series(
        _discrete_quarterly_series(quarterly_filings, annual_filings, "ic", CONCEPT_CANDIDATES["net_income"])
    )
    ocf_ttm = dict(_ttm_series(
        _discrete_quarterly_series(quarterly_filings, annual_filings, "cf", CONCEPT_CANDIDATES["operating_cash_flow"])
    ))
    capex_ttm = dict(_ttm_series(
        _discrete_quarterly_series(quarterly_filings, annual_filings, "cf", CONCEPT_CANDIDATES["capex"])
    ))
    fcf_ttm = sorted(
        (d, ocf_ttm[d] - capex_ttm[d]) for d in (ocf_ttm.keys() & capex_ttm.keys())
    )

    method_b_pe = _own_history_multiple(_per_share_ttm_series(net_income_ttm, shares_series), bars)
    method_b_pfcf = _own_history_multiple(_per_share_ttm_series(fcf_ttm, shares_series), bars)
    method_b = {
        "available": bool(method_b_pe.get("available") or method_b_pfcf.get("available")),
        "peTrailing": method_b_pe,
        "priceToFcf": method_b_pfcf,
        "note": "Real matched daily price vs. reconstructed trailing-twelve-month fundamentals at each of this "
                "ticker's own past ~quarterly points. Capped to Alpaca's free-tier price depth (confirmed live: "
                "~13 months, not the years a 5y/10y/max lookback would need) — windowStart/windowEnd below show "
                "exactly what span was actually used.",
    }
    if annual_filings and not method_b["available"]:
        flags.append("INSUFFICIENT_OWN_HISTORY_DATA")

    finviz_snapshot = {}
    try:
        from finvizfinance.util import web_scrap  # lazy import, matches earnings_calendar.py's pattern
        soup = web_scrap(f"https://finviz.com/quote.ashx?t={ticker}")
        finviz_snapshot = parse_snapshot_table(soup)
    except Exception:
        flags.append("FINVIZ_UNAVAILABLE")

    recommendations = get_recommendation_trend(ticker)

    return {
        "ticker": ticker,
        "currentPrice": current_price,
        "methodA": method_a,
        "methodB": method_b,
        "weekRangeContext": week_range,
        "fcfYieldTrend": fcf_yield_trend,
        "multiplesContext": _multiples_context(finviz_snapshot, finnhub_metrics),
        "analystSentiment": _analyst_sentiment(recommendations),
        "confidenceFlags": flags,
    }
