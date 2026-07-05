"""Flask API for the React "Swing Scanner" tab (proxied in dev via Vite's
'/swing-scanner-api' rule — see vite.config.js; called directly by an
absolute URL cross-origin in production, since Vite's dev proxy has no
effect on a built app — see src/components/SwingScanner.jsx and this
repo's render.yaml). Wraps the same pipeline.py used by the Streamlit app
(app.py) — the scan logic itself lives in exactly one place regardless of
which frontend calls it. Standalone process, separate from the other
Python services in this repo — run with:
    python api.py
"""
from __future__ import annotations

import math
import os

import pandas as pd
from flask import Flask, jsonify, request

from data import get_daily_bars, get_tradable_universe
from indicators import sma
from levels import TRAIL_RULE_TEXT, position_size
from pipeline import TEST_SUBSET, run_scan

app = Flask(__name__)

CHART_LOOKBACK_DAYS = 260

# Browser-facing endpoints below are called cross-origin from the React app
# in production (this service's own Render URL vs. stockpilot.cc) via
# fetch(), not from a same-origin proxy — so the browser enforces CORS.
# Matches backend/app.py's existing pattern.
ALLOWED_ORIGINS = {"https://stockpilot.cc", "http://localhost:5173", "http://localhost:5174"}


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin")
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.route("/api/scan", methods=["OPTIONS"])
@app.route("/api/position-size", methods=["OPTIONS"])
def cors_preflight():
    return "", 204


@app.route("/health")
def health():
    return jsonify({"status": "ok"})

# Maps the pipeline's Streamlit-display column names to the camelCase keys
# the React tab actually consumes.
COLUMN_TO_KEY = {
    "Ticker": "ticker",
    "Setup": "setup",
    "Current Price": "currentPrice",
    "Pivot / Entry": "pivotEntry",
    "Initial Stop": "initialStop",
    "Risk/Share $": "riskPerShareDollar",
    "Risk/Share %": "riskPerSharePct",
    "Target +20%": "target20",
    "RS Score": "rsScore",
    "% Off 52w High": "pctOffHigh",
    "Vol vs 50d Avg": "volVsAvg",
}


def _clean(value):
    """NaN isn't valid JSON — jsonify would otherwise emit a bare `NaN`
    token that JS's JSON.parse chokes on. None serializes as `null`."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return value


@app.route("/api/scan", methods=["POST"])
def scan():
    body = request.get_json(force=True, silent=True) or {}
    use_test_subset = body.get("useTestSubset", True)

    if use_test_subset:
        symbols = TEST_SUBSET
    else:
        try:
            symbols = get_tradable_universe()
        except Exception as exc:
            return jsonify({"error": str(exc)}), 502

    try:
        df = run_scan(symbols)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502

    if df.empty:
        return jsonify({"results": [], "scannedCount": len(symbols), "passedCount": 0})

    results = [
        {COLUMN_TO_KEY[col]: _clean(row[col]) for col in COLUMN_TO_KEY}
        for _, row in df.iterrows()
    ]

    return jsonify({
        "results": results,
        "scannedCount": len(symbols),
        "passedCount": len(results),
        "trailRule": TRAIL_RULE_TEXT,
    })


@app.route("/api/chart/<ticker>", methods=["GET"])
def chart(ticker: str):
    df = get_daily_bars(ticker.upper(), lookback_days=400)
    if df is None:
        return jsonify({"error": f"No data available for {ticker}"}), 404

    plot_df = df.tail(CHART_LOOKBACK_DAYS)
    sma50 = sma(df["c"], 50).tail(CHART_LOOKBACK_DAYS)
    sma150 = sma(df["c"], 150).tail(CHART_LOOKBACK_DAYS)
    sma200 = sma(df["c"], 200).tail(CHART_LOOKBACK_DAYS)

    series = [
        {
            "date": date.strftime("%Y-%m-%d"),
            "close": round(float(plot_df["c"].loc[date]), 2),
            "sma50": _clean(round(float(sma50.loc[date]), 2)) if pd.notna(sma50.loc[date]) else None,
            "sma150": _clean(round(float(sma150.loc[date]), 2)) if pd.notna(sma150.loc[date]) else None,
            "sma200": _clean(round(float(sma200.loc[date]), 2)) if pd.notna(sma200.loc[date]) else None,
        }
        for date in plot_df.index
    ]

    return jsonify({"ticker": ticker.upper(), "series": series})


@app.route("/api/position-size", methods=["POST"])
def position_size_endpoint():
    body = request.get_json(force=True, silent=True) or {}
    sizing = position_size(
        account_size=float(body.get("accountSize", 0)),
        risk_pct_per_trade=float(body.get("riskPct", 1.0)),
        entry=float(body.get("entry", 0)),
        stop=float(body.get("stop", 0)),
    )
    return jsonify(sizing)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8003)))
