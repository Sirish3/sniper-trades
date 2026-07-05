"""Flask API for the React "Screener" tab (proxied in dev via Vite's
'/stock-screener-api' rule — see vite.config.js). Standalone process,
separate from the other Python services in this repo — run with:
    python api.py
"""
from __future__ import annotations

from flask import Flask, jsonify, request

import db
from data import fetch_fundamentals, fetch_price_snapshot
from universe_sync import load_static_fallback, sync_universe

app = Flask(__name__)

VALID_UNIVERSES = {"sp500", "nasdaq100", "custom"}


def _ensure_seeded(universe: str) -> None:
    """First-time use: if a live-sourced universe (sp500/nasdaq100) has
    never been populated, seed it from the repo's static snapshot rather
    than making the user hit Refresh before anything shows up. `custom`
    starts genuinely empty — there's nothing to seed it with."""
    if universe == "custom":
        return
    if not db.get_universe(universe):
        db.replace_universe(universe, load_static_fallback(universe))


@app.route("/api/universe/<universe>", methods=["GET"])
def get_universe(universe: str):
    if universe not in VALID_UNIVERSES:
        return jsonify({"error": f"Unknown universe {universe!r}"}), 400
    _ensure_seeded(universe)
    return jsonify({"universe": universe, "tickers": db.get_universe(universe)})


@app.route("/api/universe/<universe>/refresh", methods=["POST"])
def refresh_universe(universe: str):
    if universe not in ("sp500", "nasdaq100"):
        return jsonify({"error": "Only sp500/nasdaq100 can be refreshed — custom is user-managed"}), 400
    try:
        tickers, source = sync_universe(universe)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502
    count = db.replace_universe(universe, tickers)
    return jsonify({"universe": universe, "count": count, "source": source})


@app.route("/api/universe/custom/add", methods=["POST"])
def add_custom():
    body = request.get_json(force=True, silent=True) or {}
    symbol = (body.get("symbol") or "").strip().upper()
    if not symbol:
        return jsonify({"error": "Missing required field: symbol"}), 400
    db.add_custom_ticker(symbol, body.get("name") or symbol, body.get("sector"))
    return jsonify({"universe": "custom", "tickers": db.get_universe("custom")})


@app.route("/api/universe/custom/remove", methods=["POST"])
def remove_custom():
    body = request.get_json(force=True, silent=True) or {}
    symbol = (body.get("symbol") or "").strip().upper()
    if not symbol:
        return jsonify({"error": "Missing required field: symbol"}), 400
    db.remove_custom_ticker(symbol)
    return jsonify({"universe": "custom", "tickers": db.get_universe("custom")})


@app.route("/api/screen", methods=["POST"])
def screen():
    body = request.get_json(force=True, silent=True) or {}
    universe = body.get("universe")
    if universe not in VALID_UNIVERSES:
        return jsonify({"error": f"Unknown universe {universe!r}"}), 400

    _ensure_seeded(universe)
    tickers = db.get_universe(universe)
    if not tickers:
        return jsonify({"universe": universe, "rows": []})

    symbols = [t["symbol"] for t in tickers]

    try:
        prices = fetch_price_snapshot(symbols)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502

    fundamentals = fetch_fundamentals(symbols)

    rows = []
    for t in tickers:
        symbol = t["symbol"]
        price_info = prices.get(symbol, {})
        fund_info = fundamentals.get(symbol, {})
        rows.append({
            "symbol": symbol,
            "name": t.get("name"),
            "sector": t.get("sector"),
            "price": price_info.get("price"),
            "changePct": round(price_info["changePct"], 2) if price_info.get("changePct") is not None else None,
            "volume": price_info.get("volume"),
            "marketCap": fund_info.get("market_cap"),
            "peRatio": round(fund_info["pe_ratio"], 2) if fund_info.get("pe_ratio") is not None else None,
        })

    return jsonify({"universe": universe, "rows": rows})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8004)
