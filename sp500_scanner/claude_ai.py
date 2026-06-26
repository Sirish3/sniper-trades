"""Claude Haiku trade-plan review for Grade A+/A/B buy signals."""

import os

from anthropic import Anthropic

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 300
TEMPERATURE = 0

# Rough Haiku 4.5 cost per call (~180 input + ~100 output tokens), used only
# for the "Est. cost" line in the final report.
EST_COST_PER_CALL = 0.0006

NA_REVIEW = {
    "claude_trade": "N/A",
    "claude_entry": "N/A",
    "claude_stop": "N/A",
    "claude_target": "N/A",
    "claude_hold": "N/A",
    "claude_reason": "N/A",
}

_client = None
_warned_no_key = False


def _get_client():
    """Lazily create the Anthropic client, warning once if no key is set."""
    global _client, _warned_no_key

    if _client is not None:
        return _client

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        if not _warned_no_key:
            print("⚠️  ANTHROPIC_API_KEY not set — skipping Claude analysis")
            _warned_no_key = True
        return None

    _client = Anthropic(api_key=api_key)
    return _client


def _build_prompt(r, regime):
    spy_status = "above 200MA" if regime["spy_above_200"] else "below 200MA"
    return f"""MARKET REGIME: {regime['regime_label']} ({regime['regime_score']}/100)
SPY: {spy_status} | VIX: {regime['vix_current']:.1f} ({regime['vix_label']})
Breadth: {regime['breadth_label']}

Swing trade analysis for {r['symbol']} ({r['sector']})
Score: {r['score']}/100  Grade: {r['grade']} ({r['signal']})
Position size guidance: {r['position_size_pct']}% of normal

C1 ({r['c1_pts']}/25): 10 EMA ${r['ema10']:.2f} vs 20 EMA ${r['ema20']:.2f}
        EMA gap: {r['ema_gap_pct']:+.2f}%
C2 ({r['c2_pts']}/20): Price ${r['price']:.2f} vs 50 EMA ${r['ema50']:.2f}
        ({r['price_above_50_pct']:+.2f}% above)
C3 ({r['c3_pts']}/25): MACD {r['macd_now']:.3f} vs Signal {r['signal_now']:.3f} — {r['macd_signal']}
C4 ({r['c4_pts']}/15): RSI {r['rsi']:.1f} — {r['rsi_zone']}
C5 ({r['c5_pts']}/15): Volume {r['volume_ratio']:.2f}x average — {r['volume_label']}

Respond ONLY in this exact format:
TRADE: [TAKE IT / SKIP IT]
ENTRY: $X
STOP: $X (-X%)
TARGET: $X (+X%)
HOLD: X-X days
REASON: (1 sentence — mention regime if relevant)"""


def _parse_response(text):
    fields = dict(NA_REVIEW)
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if ":" not in line:
            continue
        upper = line.upper()
        value = line.split(":", 1)[1].strip()
        if upper.startswith("TRADE:"):
            fields["claude_trade"] = value
        elif upper.startswith("ENTRY:"):
            fields["claude_entry"] = value
        elif upper.startswith("STOP:"):
            fields["claude_stop"] = value
        elif upper.startswith("TARGET:"):
            fields["claude_target"] = value
        elif upper.startswith("HOLD:"):
            fields["claude_hold"] = value
        elif upper.startswith("REASON:"):
            fields["claude_reason"] = value
    return fields


def get_trade_review(result, regime):
    """Ask Claude Haiku for a trade plan on a Grade A+/A/B buy signal.

    `regime` is the dict returned by analysis.market_regime.check_market_regime(),
    included so Claude can factor overall market health into its call.

    Returns all-"N/A" fields (never raises) if there's no API key or the
    call fails, so a Claude outage never breaks the scan.
    """
    client = _get_client()
    if client is None:
        return dict(NA_REVIEW)

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            temperature=TEMPERATURE,
            messages=[{"role": "user", "content": _build_prompt(result, regime)}],
        )
        return _parse_response(response.content[0].text)
    except Exception:
        return dict(NA_REVIEW)
