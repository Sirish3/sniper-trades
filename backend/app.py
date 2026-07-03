"""Read-only status website. Starts the scheduler in-process on boot.

IMPORTANT — deploy with exactly one worker process. The scheduler starts
once per process; running this under gunicorn with >1 worker (or any
horizontally-scaled setup) would run every job — and send every alert —
once per worker. See backend/README.md for the deployment notes.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template_string, request

from alerts import is_duplicate, send_email
from database import AlertLog, Position, get_session
from qqq_signal import build_qqq_email, get_qqq_signal, load_previous_state
from portfolio import create_manual_position
from scheduler import start_scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Starts exactly once per process. app.run() below does not enable Flask's
# debug/reloader mode, so this module is only ever imported/executed once
# per process — if you turn on debug=True locally, guard this behind
# os.environ.get("WERKZEUG_RUN_MAIN") == "true" first, or the reloader's
# parent process will start a second, redundant scheduler.
_scheduler = start_scheduler()

STATUS_PAGE = """
<!doctype html>
<title>Execution Scheduler Status</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; color: #1a1a1a; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #ddd; font-size: 0.9rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
  .pnl-pos { color: #0a7a3f; } .pnl-neg { color: #b91c1c; }
</style>
<h1>Execution Scheduler</h1>
<p>Jobs: 10:00 AM entry | 2:00 PM retest+trim | 3:50 PM exit (Mon-Fri, US/Eastern)</p>
<p>QQQ cycle: 9:00 AM CST morning brief | 2:30 PM CST pre-close | 4:15 PM CST final signal</p>

<h2>Open Positions ({{ positions|length }})</h2>
<table>
  <tr><th>Ticker</th><th>Grade</th><th>Entry</th><th>Shares</th><th>Stop</th><th>Trim1</th><th>Trim2</th><th>Pending Close</th></tr>
  {% for p in positions %}
  <tr>
    <td>{{ p.ticker }}</td><td>{{ p.grade }}</td><td>${{ "%.2f"|format(p.entry_price) }}</td>
    <td>{{ p.shares }}</td><td>${{ "%.2f"|format(p.current_stop) }}</td>
    <td>{{ "Yes" if p.trim1_executed else "No" }}</td><td>{{ "Yes" if p.trim2_executed else "No" }}</td>
    <td>{{ p.pending_close_reason or "" }}</td>
  </tr>
  {% endfor %}
</table>

<h2>Recent Alerts</h2>
<table>
  <tr><th>Sent</th><th>Type</th><th>Ticker</th></tr>
  {% for a in alerts %}
  <tr><td>{{ a.sent_at }}</td><td>{{ a.alert_type }}</td><td>{{ a.ticker }}</td></tr>
  {% endfor %}
</table>
"""


@app.route("/")
def status() -> str:
    with get_session() as session:
        positions = session.query(Position).filter(Position.status == "OPEN").all()
        alerts = session.query(AlertLog).order_by(AlertLog.sent_at.desc()).limit(20).all()
        return render_template_string(STATUS_PAGE, positions=positions, alerts=alerts)


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/positions")
def positions_json():
    with get_session() as session:
        rows = session.query(Position).filter(Position.status == "OPEN").all()
        return jsonify([
            {
                "id": p.id, "ticker": p.ticker, "grade": p.grade, "entry_price": p.entry_price,
                "shares": p.shares, "current_stop": p.current_stop,
                "trim1_executed": p.trim1_executed, "trim2_executed": p.trim2_executed,
                "pending_close": p.pending_close, "pending_close_reason": p.pending_close_reason,
            }
            for p in rows
        ])


@app.route("/alerts")
def alerts_json():
    with get_session() as session:
        rows = session.query(AlertLog).order_by(AlertLog.sent_at.desc()).limit(50).all()
        return jsonify([
            {"id": a.id, "ticker": a.ticker, "alert_type": a.alert_type, "sent_at": a.sent_at.isoformat(), "status": a.status}
            for a in rows
        ])


@app.route("/api/alert/screener-buy", methods=["POST"])
def screener_buy_alert():
    """Called from the React app's Screener tab — a fully separate scan
    (client-side, 5-condition) from this backend's own 52w-breakout scan.
    Just sends one email and logs it for the 24h dedup window; does not
    touch the Position table (the React app tracks its own positions in
    localStorage, unrelated to this backend's database).
    """
    data = request.get_json(silent=True) or {}
    ticker = data.get("ticker")
    if not ticker:
        return jsonify({"ok": False, "error": "ticker required"}), 400

    if is_duplicate(ticker, "SCREENER_BUY"):
        return jsonify({"ok": False, "error": "duplicate within 24h"}), 200

    subject = f"SCREENER {data.get('strength', 'BUY')}: {ticker}"
    body = (
        f"{data.get('strength', 'BUY')}: {ticker} ({data.get('name', '')})\n"
        f"Price:  ${data.get('price', 0):.2f}\n"
        f"10 EMA: ${data.get('ema10', 0):.2f}\n"
        f"20 EMA: ${data.get('ema20', 0):.2f}\n"
        f"50 EMA: ${data.get('ema50', 0):.2f}\n"
        f"RSI:    {data.get('rsi', 0):.1f} ({data.get('rsiZone', '')})\n"
        f"Volume: {data.get('volumeRatio', 0):.2f}x ({data.get('volumeLabel', '')})\n"
        f"Sector: {data.get('sector', '')}"
    )
    claude_trade = data.get("claudeTrade")
    if claude_trade and claude_trade != "N/A":
        body += (
            f"\n\nClaude: {claude_trade}\n"
            f"Entry {data.get('claudeEntry', '')} | Stop {data.get('claudeStop', '')} | "
            f"Target {data.get('claudeTarget', '')} | Hold {data.get('claudeHold', '')}\n"
            f"{data.get('claudeReason', '')}"
        )

    success = send_email(subject, body)

    with get_session() as session:
        session.add(AlertLog(
            ticker=ticker,
            alert_type="SCREENER_BUY",
            message=body,
            price=data.get("price"),
            grade=data.get("strength"),
        ))

    return jsonify({"ok": success})


@app.route("/api/positions/manual", methods=["POST"])
def add_manual_position():
    """Tracks a stock you already hold under this scheduler's own Position
    table — separate from the React app's own localStorage position list,
    which only gets evaluated when you have that page open. A position
    created here is picked up by the EXISTING 2:00 PM trim-check job and
    3:50 PM stop/time-stop job with no further wiring, since those already
    run against every OPEN Position regardless of how it was created —
    so once added, trim/stop/time-stop suggestions arrive by email on the
    normal schedule, the same as for scan-found positions.
    """
    data = request.get_json(silent=True) or {}
    ticker = data.get("ticker")
    entry_price = data.get("entry_price")
    shares = data.get("shares")
    if not ticker or not entry_price or not shares:
        return jsonify({"error": "ticker, entry_price, and shares are required"}), 400

    entry_date = None
    if data.get("entry_date"):
        try:
            entry_date = datetime.strptime(data["entry_date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return jsonify({"error": "entry_date must be YYYY-MM-DD"}), 400

    try:
        position_id = create_manual_position(
            ticker=ticker.upper(), entry_price=float(entry_price), shares=int(shares),
            entry_date=entry_date, grade=data.get("grade"), sector_etf=data.get("sector_etf"),
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    with get_session() as session:
        position = session.get(Position, position_id)
        return jsonify({
            "ok": True,
            "position_id": position_id,
            "stop": round(position.current_stop, 2),
            "trim1": round(position.trim1_price, 2),
            "trim2": round(position.trim2_price, 2),
        })


@app.route("/api/qqq-signal/send", methods=["POST"])
def qqq_signal_send():
    """On-demand QQQ signal email — called from the React app's 'Send Signal Email' button.

    Sends the same email as the 4:15 PM close job (authoritative signal),
    but without saving state (so it doesn't affect tomorrow's SWITCH detection).
    Does NOT require the market to be open — useful for manual checks anytime.
    """
    try:
        signal     = get_qqq_signal()
        prev_state = load_previous_state()
        subject, body = build_qqq_email(signal, prev_state, timing="close")
        ok = send_email(subject, body)
        return jsonify({
            "ok": ok,
            "state": signal["state"],
            "price": round(signal["price"], 2),
            "ema10": round(signal["ema10"], 2),
        })
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
