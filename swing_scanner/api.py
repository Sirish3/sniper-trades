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
from datetime import date as date_cls, timedelta

import pandas as pd
from flask import Flask, jsonify, request

from chart_setups import STATUSES, create_setup, delete_setup, get_setup, list_setups, pattern_counts, update_setup
from data import bars_df_to_candles, get_daily_bars, get_tradable_universe
from database import init_db
from earnings_calendar import get_earnings_for_tickers
from economic_calendar import filter_calendar, get_economic_calendar, next_high_impact_event
from indicators import sma
from levels import TRAIL_RULE_TEXT, position_size
from pipeline import TEST_SUBSET, run_scan
from scheduler import start_scheduler

app = Flask(__name__)
init_db()
start_scheduler()

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
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.route("/api/scan", methods=["OPTIONS"])
@app.route("/api/position-size", methods=["OPTIONS"])
@app.route("/api/setups", methods=["OPTIONS"])
@app.route("/api/setups/<setup_id>", methods=["OPTIONS"])
def cors_preflight(setup_id=None):
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
    "Caution Tags": "cautionTags",
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


def _parse_date_param(value: str | None) -> date_cls | None:
    if not value:
        return None
    try:
        return date_cls.fromisoformat(value)
    except ValueError:
        return None


@app.route("/api/economic-calendar", methods=["GET"])
def economic_calendar_endpoint():
    """Query params (all optional): impact=High,Medium  start=YYYY-MM-DD
    end=YYYY-MM-DD  refresh=1. Defaults match economic_calendar.py's own
    defaults (High+Medium, this week + next week) when omitted."""
    impact_param = request.args.get("impact")
    impact_levels = set(impact_param.split(",")) if impact_param else None
    start = _parse_date_param(request.args.get("start"))
    end = _parse_date_param(request.args.get("end"))
    force_refresh = request.args.get("refresh") in ("1", "true", "True")

    events, live_ok = get_economic_calendar(force_refresh=force_refresh)
    filtered = filter_calendar(events, impact_levels=impact_levels, start_date=start, end_date=end)

    nearest = next_high_impact_event(events)
    next_high_impact = None
    if nearest:
        event, days = nearest
        next_high_impact = {"event": event.event, "date": event.date, "daysUntil": days}

    return jsonify({
        "liveDataAvailable": live_ok,
        "nextHighImpact": next_high_impact,
        "events": [
            {
                "date": e.date, "time": e.time, "event": e.event, "impact": e.impact,
                "actual": e.actual, "forecast": e.forecast, "previous": e.previous, "source": e.source,
            }
            for e in filtered
        ],
    })


@app.route("/api/earnings", methods=["GET"])
def earnings_endpoint():
    """?tickers=AAPL,MSFT,... (required, comma-separated) &refresh=1"""
    tickers_param = request.args.get("tickers", "")
    tickers = [t.strip().upper() for t in tickers_param.split(",") if t.strip()]
    if not tickers:
        return jsonify({"error": "Missing required query param: tickers"}), 400

    force_refresh = request.args.get("refresh") in ("1", "true", "True")
    infos = get_earnings_for_tickers(tickers, force_refresh=force_refresh)

    return jsonify({
        "results": [
            {
                "ticker": info.ticker,
                "nextEarningsDate": info.next_earnings_date,
                "daysUntil": info.days_until,
                "beforeAfterMarket": info.before_after,
                "estEps": info.est_eps,
                "priorQtrEps": info.prior_qtr_eps,
                "earningsRisk": info.earnings_risk,
                "error": info.error,
            }
            for info in infos
        ],
    })


# ── Chart Patterns (manually curated setup gallery) ──────────────────────

@app.route("/api/setups", methods=["GET"])
def setups_list():
    """Public gallery: published setups only, optional ?pattern=X filter.
    The admin form passes ?status=all to manage drafts/archived setups too."""
    pattern_type = request.args.get("pattern")
    status = request.args.get("status", "published")
    return jsonify({"results": list_setups(status=None if status == "all" else status, pattern_type=pattern_type)})


@app.route("/api/setups/pattern-counts", methods=["GET"])
def setups_pattern_counts():
    return jsonify({"results": pattern_counts(status="published")})


@app.route("/api/setups/<setup_id>", methods=["GET"])
def setups_get(setup_id):
    setup = get_setup(setup_id)
    if setup is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(setup)


@app.route("/api/setups/<setup_id>/candles", methods=["GET"])
def setups_candles(setup_id):
    setup = get_setup(setup_id)
    if setup is None:
        return jsonify({"error": "Not found"}), 404

    days = int(request.args.get("days", 180))
    # Only daily bars are available (data.py's get_daily_bars); the
    # `timeframe` param is accepted for forward-compatibility but anything
    # other than 1Day currently just falls back to daily.
    df = get_daily_bars(setup["ticker"], lookback_days=days)
    if df is None:
        return jsonify({"error": f"No price data available for {setup['ticker']}"}), 404

    return jsonify({"ticker": setup["ticker"], "candles": bars_df_to_candles(df, days=days)})


@app.route("/api/setups", methods=["POST"])
def setups_create():
    body = request.get_json(force=True, silent=True) or {}
    if not body.get("ticker") or not body.get("patternType"):
        return jsonify({"error": "ticker and patternType are required"}), 400
    return jsonify(create_setup(body)), 201


@app.route("/api/setups/<setup_id>", methods=["PUT"])
def setups_update(setup_id):
    body = request.get_json(force=True, silent=True) or {}
    if "status" in body and body["status"] not in STATUSES:
        return jsonify({"error": f"status must be one of {sorted(STATUSES)}"}), 400
    updated = update_setup(setup_id, body)
    if updated is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify(updated)


@app.route("/api/setups/<setup_id>", methods=["DELETE"])
def setups_delete(setup_id):
    if not delete_setup(setup_id):
        return jsonify({"error": "Not found"}), 404
    return "", 204


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8003)))
