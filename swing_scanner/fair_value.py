"""Fair-value estimation for one ticker, built entirely from data already
free-tier-available across this repo's existing providers — no new paid
data source. Three independent angles, deliberately never blended into one
number (each measures something different; averaging them would hide which
one is actually doing the work):

  1. FCF yield/trend — free cash flow (operating cash flow - capex) from
     Finnhub's SEC-EDGAR-sourced financial statements (see
     finnhub_client.py::get_financials_reported), compared against the
     ticker's OWN multi-year FCF-yield history. Self-referential (current
     vs this-same-company's-past), so it needs no external sector
     comparison to be meaningful.
  2. Relative multiples — P/E, Forward P/E, PEG, P/S, P/B, P/FCF,
     EV/EBITDA, ROE/ROA/ROIC, margins, Debt/Eq, all pulled from Finviz's
     quote-page snapshot table (see finviz_snapshot.py) plus the rest of
     Finnhub's /stock/metric payload. Shown as CONTEXT, not synthesized
     into a price — there's no free sector/industry P/E benchmark
     available from any of this repo's providers (confirmed live), and
     multiplying a ticker's own EPS by its own P/E is circular (it just
     reproduces the current price), so no fair-value number is invented
     from these.
  3. 52-week range context — current price vs. Alpaca-derived 52-week
     high/low. A mean-reversion sanity check, not a valuation method.

Plus analyst sentiment (Finnhub /stock/recommendation — buy/hold/sell
counts, NOT a price: confirmed live that /stock/price-target 403s on the
free tier, and Finviz's current snapshot table no longer has a Target
Price field either — there is no free analyst price-target source across
any provider this repo has access to).

DESIGN NOTE — why FCF is "most recent full fiscal year," not trailing
twelve months: confirmed live that Finnhub's "quarterly" filings report
cumulative fiscal-year-to-date figures (standard 10-Q practice), not
discrete quarters — e.g. AAPL's Q1/Q2 operating cash flow for the same
fiscal year were $29.9B then $82.6B, the second including the first, not
a separate figure. Naively summing 4 "quarterly" filings would badly
overcount. Reconstructing a true TTM from cumulative quarters (latest
YTD + prior full year - same YTD a year ago) is doable but adds real
failure modes (fiscal-year-end mismatches, restatements) for a first
version — annual filings report clean single-year figures with no such
ambiguity, at the cost of being up to ~12 months stale right before a
fiscal year end. That staleness is surfaced via STALE_ANNUAL_DATA below,
not hidden.

Data map (which field comes from where):
  Alpaca  (data.py::get_daily_bars)        -> 52w high/low, current price
  Finnhub (finnhub_client.py):
    /stock/financials-reported (annual)    -> revenue, net income,
                                               operating cash flow, capex,
                                               diluted shares, cash, debt
                                               (matched by XBRL `concept`
                                               tag, not `label` — labels
                                               vary wildly per filer)
    /stock/metric?metric=all               -> PEG, market cap, beta, ROE,
                                               margins, debt/equity, etc.
    /stock/recommendation                  -> analyst buy/hold/sell trend
  Finviz  (finviz_snapshot.py)             -> P/E, Forward P/E, P/S, P/B,
                                               P/FCF, EV/EBITDA, ROA, ROIC,
                                               52W High/Low (cross-check),
                                               Debt/Eq, margins
"""
from __future__ import annotations

from dataclasses import dataclass, field

from datetime import date, datetime

from data import get_daily_bars
from finnhub_client import get_basic_financials, get_financials_reported, get_recommendation_trend
from finviz_snapshot import parse_snapshot_table

MIN_ANNUAL_YEARS_FOR_TREND = 3   # fewer than this and a CAGR is more noise than signal
STALE_ANNUAL_DATA_DAYS = 400     # most recent fiscal year-end older than this -> flag it
FCF_YIELD_HISTORY_YEARS = 5      # how many years back to compute the "own history" FCF yield range
LOW_LIQUIDITY_AVG_VOLUME = 100_000  # 20-day avg volume below this -> current price is a less trustworthy anchor

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
    # Debt/cash are best-effort only (see ENTERPRISE_VALUE note below) —
    # concept naming varies more here than any other line item (AAPL uses
    # LongTermDebtCurrent/Noncurrent; SATS uses a completely different
    # LongTermDebtAndCapitalLeaseObligations* pair) — summed across every
    # matching concept present, since filers split these into current/
    # noncurrent components rather than reporting one total.
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


def _sum_concept_values(items: list[dict], candidates: list[str]) -> float | None:
    """Sums every distinct matching concept present (for figures SEC
    filings commonly split into components, like current + noncurrent
    debt) — a single filer only ever uses one naming convention, so this
    doesn't double-count across AAPL-style vs. SATS-style tagging, it just
    sums whichever one this specific filing actually uses."""
    total = 0.0
    found = False
    seen = set()
    for item in items:
        concept = item.get("concept")
        if concept in candidates and concept not in seen and item.get("value") is not None:
            total += float(item["value"])
            seen.add(concept)
            found = True
    return total if found else None


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


def _compute_fcf_yield_trend(annual_filings: list[dict], market_cap: float | None) -> dict:
    figures = [f for f in (_extract_annual_figures(filing) for filing in annual_filings) if f is not None]
    figures = [f for f in figures if f.fcf is not None]
    figures.sort(key=lambda f: f.end_date, reverse=True)

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
        "sectorPe": None,  # confirmed unavailable free from any provider — never invented, always null
        "note": "Context only, not a fair-value estimate — there is no free sector/industry P/E benchmark "
                "available from any provider this app uses, and multiplying a stock's own EPS by its own P/E "
                "just reproduces the current price.",
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


def get_fair_value(ticker: str) -> dict:
    ticker = ticker.upper()
    flags: list[str] = []

    bars = get_daily_bars(ticker, lookback_days=400)
    week_range = _week_range_context(bars)
    if week_range.get("fetchFailed"):
        flags.append("PRICE_DATA_UNAVAILABLE")
    elif week_range.get("avgVolume20") is not None and week_range["avgVolume20"] < LOW_LIQUIDITY_AVG_VOLUME:
        flags.append("LOW_LIQUIDITY")

    annual_filings = get_financials_reported(ticker, freq="annual")
    if not annual_filings:
        flags.append("MISSING_FINANCIALS")
    elif len(annual_filings) < MIN_ANNUAL_YEARS_FOR_TREND:
        flags.append("THIN_HISTORY")

    finnhub_metrics = get_basic_financials(ticker)
    market_cap = finnhub_metrics.get("marketCapitalization")
    market_cap = market_cap * 1e6 if isinstance(market_cap, (int, float)) else None

    if annual_filings:
        fcf_yield_trend = _compute_fcf_yield_trend(annual_filings, market_cap)
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

    try:
        from finvizfinance.util import web_scrap  # lazy import, matches earnings_calendar.py's pattern
        soup = web_scrap(f"https://finviz.com/quote.ashx?t={ticker}")
        finviz_snapshot = parse_snapshot_table(soup)
    except Exception:
        finviz_snapshot = {}
        flags.append("FINVIZ_UNAVAILABLE")

    recommendations = get_recommendation_trend(ticker)

    return {
        "ticker": ticker,
        "weekRangeContext": week_range,
        "fcfYieldTrend": fcf_yield_trend,
        "multiplesContext": _multiples_context(finviz_snapshot, finnhub_metrics),
        "analystSentiment": _analyst_sentiment(recommendations),
        # NO_SECTOR_COMP isn't here — it's true for every ticker, always
        # (no free sector/industry P/E benchmark exists from any provider,
        # see _multiples_context's own note), so it carries no per-ticker
        # signal. Stated once in multiplesContext.note instead.
        "confidenceFlags": flags,
    }
