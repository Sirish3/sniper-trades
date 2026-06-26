"""Market regime detection — gates the scanner on overall market health.

Fetches SPY, QQQ, IWM, and ^VIX in a single batched yfinance call and scores
the market 0-100 across SPY trend, VIX fear, small-cap breadth (IWM), and
Nasdaq health (QQQ). main.py uses this score to decide whether to run the
full scan, watchlist-only, or abort before touching any S&P 500 ticker.
"""

import pandas as pd
import yfinance as yf

REGIME_TICKERS = ["SPY", "QQQ", "IWM", "^VIX"]
PERIOD = "1y"
INTERVAL = "1d"

# Fallback scores used when an instrument's data can't be fetched.
VIX_SCORE_DEFAULT = 12
BREADTH_SCORE_DEFAULT = 10
QQQ_SCORE_DEFAULT = 7

RUN_SCAN_THRESHOLD_DEFAULT = 55
ABORT_THRESHOLD = 40


class RegimeDataError(Exception):
    """Raised when SPY data can't be fetched — the scanner can't run without it."""


def _clean_close(df):
    """Return a cleaned close-price Series, or None if unusable."""
    if df is None or df.empty:
        return None

    df = df.rename(columns=str.lower)
    if "close" not in df.columns:
        return None

    close = df["close"].dropna()
    if close.empty:
        return None

    return close


def _fetch_closes():
    """Batch-download SPY/QQQ/IWM/^VIX and return {ticker: close_series or None}."""
    try:
        batch = yf.download(
            REGIME_TICKERS, period=PERIOD, interval=INTERVAL,
            group_by="ticker", auto_adjust=True, progress=False,
        )
    except Exception:
        batch = None

    closes = {}
    for ticker in REGIME_TICKERS:
        close = None
        if batch is not None and not batch.empty and isinstance(batch.columns, pd.MultiIndex):
            try:
                close = _clean_close(batch[ticker])
            except KeyError:
                close = None
        closes[ticker] = close

    return closes


def _safe_sma(close, window):
    """Rolling mean at `window`, falling back to the full-series mean if too short."""
    value = close.rolling(window).mean().iloc[-1]
    if pd.isna(value):
        value = close.mean()
    return value


def _score_spy_trend(close):
    price = close.iloc[-1]
    sma50 = _safe_sma(close, 50)
    sma200 = _safe_sma(close, 200)
    ema20 = close.ewm(span=20, adjust=False).mean().iloc[-1]

    above_200 = price > sma200
    above_50 = price > sma50
    golden_cross = sma50 > sma200
    above_ema20 = price > ema20

    score = 0
    if above_200:
        score += 15
    if above_50:
        score += 10
    if golden_cross:
        score += 10
    if above_ema20:
        score += 5

    if score >= 35:
        label = "STRONG BULL"
    elif score >= 25:
        label = "BULL"
    elif score >= 15:
        label = "NEUTRAL"
    elif score >= 5:
        label = "BEAR"
    else:
        label = "STRONG BEAR"

    return {
        "spy_price": price,
        "spy_sma50": sma50,
        "spy_sma200": sma200,
        "spy_ema20": ema20,
        "spy_above_200": above_200,
        "spy_above_50": above_50,
        "spy_above_ema20": above_ema20,
        "golden_cross": golden_cross,
        "spy_trend_score": score,
        "spy_trend_label": label,
    }


def _score_vix(close):
    vix_current = close.iloc[-1]
    vix_sma20 = _safe_sma(close, 20)

    if vix_current > 40:
        score = -10
        label = "CRISIS — exit everything"
    elif vix_current > 30:
        score = 0
        label = "PANIC — avoid new longs"
    elif vix_current > 25:
        score = 5
        label = "FEARFUL — reduce exposure"
    elif vix_current > 20:
        score = 12
        label = "CAUTIOUS — proceed carefully"
    elif vix_current > 15:
        score = 20
        label = "CALM — healthy market"
    else:
        score = 25
        label = "COMPLACENT — ideal bull conditions"

    trend = "RISING" if vix_current > vix_sma20 else "FALLING"

    return {
        "vix_current": vix_current,
        "vix_sma20": vix_sma20,
        "vix_trend": trend,
        "vix_score": score,
        "vix_label": label,
    }


def _score_breadth(close):
    price = close.iloc[-1]
    sma50 = _safe_sma(close, 50)
    sma200 = _safe_sma(close, 200)

    above_200 = price > sma200
    above_50 = price > sma50

    lookback = min(21, len(close) - 1)
    return_1m = (price / close.iloc[-1 - lookback] - 1) * 100 if lookback > 0 else 0.0

    score = 0
    if above_200:
        score += 10
    if above_50:
        score += 5
    if return_1m > 0:
        score += 5

    if score >= 15:
        label = "BROAD PARTICIPATION — best bull signal"
    elif score >= 8:
        label = "NARROW — large caps only leading"
    else:
        label = "WEAK BREADTH — distribution likely"

    return {
        "iwm_price": price,
        "iwm_sma50": sma50,
        "iwm_sma200": sma200,
        "iwm_above_200": above_200,
        "iwm_above_50": above_50,
        "iwm_return_1m": return_1m,
        "breadth_score": score,
        "breadth_label": label,
    }


def _score_qqq(close):
    price = close.iloc[-1]
    sma50 = _safe_sma(close, 50)
    sma200 = _safe_sma(close, 200)

    above_200 = price > sma200
    above_50 = price > sma50

    lookback = min(5, len(close) - 1)
    return_5d = (price / close.iloc[-1 - lookback] - 1) * 100 if lookback > 0 else 0.0

    score = 0
    if above_200:
        score += 8
    if above_50:
        score += 4
    if return_5d > 0:
        score += 3

    return {
        "qqq_price": price,
        "qqq_sma50": sma50,
        "qqq_sma200": sma200,
        "qqq_above_200": above_200,
        "qqq_above_50": above_50,
        "qqq_return_5d": return_5d,
        "qqq_score": score,
    }


def _classify_regime(score):
    if score >= 85:
        return "STRONG BULL", "✅✅"
    if score >= 70:
        return "BULL", "✅"
    if score >= 55:
        return "WEAK BULL", "⚠️"
    if score >= 40:
        return "NEUTRAL", "⚠️"
    if score >= 25:
        return "BEAR", "❌"
    return "STRONG BEAR", "❌❌"


def check_market_regime(threshold=RUN_SCAN_THRESHOLD_DEFAULT):
    """Fetch SPY/QQQ/IWM/VIX and compute the 0-100 market regime score.

    `threshold` is the minimum regime_score required to run the scan
    (default 55, overridable via --regime-threshold). The hard abort
    boundary (score < ABORT_THRESHOLD) is fixed regardless of `threshold`.

    Raises RegimeDataError if SPY data can't be fetched — the scanner
    cannot run without it.
    """
    closes = _fetch_closes()
    warnings = []

    spy_close = closes["SPY"]
    if spy_close is None:
        raise RegimeDataError("Failed to fetch SPY data — cannot run scanner without it")
    if len(spy_close) < 200:
        warnings.append(f"SPY history is only {len(spy_close)} bars (<200) — using available bars for long-term averages")
    spy = _score_spy_trend(spy_close)

    vix_close = closes["^VIX"]
    if vix_close is None:
        warnings.append("VIX fetch failed — using default VIX score (12/25)")
        vix = {
            "vix_current": 0.0,
            "vix_sma20": 0.0,
            "vix_trend": "UNKNOWN",
            "vix_score": VIX_SCORE_DEFAULT,
            "vix_label": "UNKNOWN — VIX data unavailable",
        }
    else:
        if len(vix_close) < 20:
            warnings.append(f"VIX history is only {len(vix_close)} bars (<20) — using available bars for trend average")
        vix = _score_vix(vix_close)

    iwm_close = closes["IWM"]
    if iwm_close is None:
        warnings.append("IWM fetch failed — using default breadth score (10/20)")
        breadth = {
            "iwm_price": 0.0,
            "iwm_sma50": 0.0,
            "iwm_sma200": 0.0,
            "iwm_above_200": False,
            "iwm_above_50": False,
            "iwm_return_1m": 0.0,
            "breadth_score": BREADTH_SCORE_DEFAULT,
            "breadth_label": "UNKNOWN — IWM data unavailable",
        }
    else:
        if len(iwm_close) < 200:
            warnings.append(f"IWM history is only {len(iwm_close)} bars (<200) — using available bars for long-term averages")
        breadth = _score_breadth(iwm_close)

    qqq_close = closes["QQQ"]
    if qqq_close is None:
        warnings.append("QQQ fetch failed — using default Nasdaq score (7/15)")
        qqq = {
            "qqq_price": 0.0,
            "qqq_sma50": 0.0,
            "qqq_sma200": 0.0,
            "qqq_above_200": False,
            "qqq_above_50": False,
            "qqq_return_5d": 0.0,
            "qqq_score": QQQ_SCORE_DEFAULT,
        }
    else:
        if len(qqq_close) < 200:
            warnings.append(f"QQQ history is only {len(qqq_close)} bars (<200) — using available bars for long-term averages")
        qqq = _score_qqq(qqq_close)

    regime_score = spy["spy_trend_score"] + vix["vix_score"] + breadth["breadth_score"] + qqq["qqq_score"]
    regime_score = max(0, min(100, regime_score))
    regime_label, regime_emoji = _classify_regime(regime_score)

    run_scan = regime_score >= threshold
    position_warning = threshold <= regime_score < 70
    vix_elevated = vix["vix_current"] > 30

    result = {
        "regime_score": regime_score,
        "regime_label": regime_label,
        "regime_emoji": regime_emoji,
        "run_scan": run_scan,
        "show_signals": run_scan,
        "position_warning": position_warning,
        "vix_elevated": vix_elevated,
        "warnings": warnings,
    }
    result.update(spy)
    result.update(vix)
    result.update(breadth)
    result.update(qqq)
    return result
