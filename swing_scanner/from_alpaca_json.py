"""Adapter between this app's Alpaca-candle JSON shape and
pattern_detector.py. The candle shape here is exactly what
data.py::bars_df_to_candles produces (used by both the /api/chart and
/api/setups/<id>/candles routes in api.py) — {date, open, high, low,
close, volume} dicts — so this module has no Alpaca dependency of its
own, just a pandas conversion step.
"""
from __future__ import annotations

import pandas as pd

from pattern_detector import PatternMatch, detect_patterns


def _candles_to_df(candles: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(candles)
    df["date"] = pd.to_datetime(df["date"])
    df = df.set_index("date").sort_index()
    return df[["open", "high", "low", "close", "volume"]]


def _match_to_setup_dict(match: PatternMatch, ticker: str) -> dict:
    """Same key shape chart_setups.py's create_setup/update_setup accept,
    plus an extra 'confidence' key — informational only, dropped before
    anything reaches the database (see pattern_scan.py)."""
    return {
        "ticker": ticker.upper(),
        "patternType": match.pattern_type,
        "supportLow": match.support_low,
        "supportHigh": match.support_high,
        "resistance": match.resistance,
        "chartAnnotations": {
            "trendlines": match.trendlines,
            "zones": match.zones,
            "hlines": match.hlines,
        },
        "confidence": match.confidence,
    }


def detect_patterns_from_json(candles: list[dict], ticker: str) -> list[dict]:
    """candles: [{date, open, high, low, close, volume}, ...]. Returns a
    list of setup dicts (possibly empty) — one per pattern matched."""
    if not candles:
        return []
    df = _candles_to_df(candles)
    matches = detect_patterns(df)
    return [_match_to_setup_dict(m, ticker) for m in matches]
