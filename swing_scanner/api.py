"""Flask API backing the React app's Economic Calendar tab (proxied in dev
via Vite's '/swing-scanner-api' rule — see vite.config.js; called directly
by an absolute URL cross-origin in production, since Vite's dev proxy has
no effect on a built app — see src/components/EconomicCalendar.jsx and
this repo's render.yaml). Standalone process, separate from the other
Python services in this repo — run with:
    python api.py
"""
from __future__ import annotations

import os
from datetime import date as date_cls

from flask import Flask, jsonify, request

from economic_calendar import filter_calendar, get_economic_calendar, next_high_impact_event

app = Flask(__name__)

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


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8003)))
