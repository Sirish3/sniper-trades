"""Entry/stop/target calculations for a confirmed VCP setup."""
from __future__ import annotations

from dataclasses import dataclass

TRAIL_RULE_TEXT = "Move stop to breakeven at +20%; trail below 21 EMA after +25%"


@dataclass
class Levels:
    entry_trigger: float
    volume_threshold: float
    initial_stop: float
    risk_per_share: float
    risk_pct: float
    target1: float
    trail_rule: str = TRAIL_RULE_TEXT


def compute_levels(pivot: float, atr14: float, avg_volume_50: float) -> Levels:
    """pivot: the VCP pivot (breakout level) from screener.detect_vcp().
    atr14 / avg_volume_50: the ticker's current ATR(14) and 50-day average
    volume (from indicators.py), used to size the stop and the volume
    confirmation threshold.
    """
    entry = pivot + 0.10

    eight_pct_stop = entry * 0.92
    two_atr_stop = entry - 2 * atr14
    # max() picks whichever stop price is HIGHER, i.e. closer to entry —
    # the tighter (smaller-loss) of the two stops, per the spec.
    initial_stop = max(eight_pct_stop, two_atr_stop)

    risk_per_share = entry - initial_stop
    risk_pct = risk_per_share / entry * 100

    return Levels(
        entry_trigger=entry,
        volume_threshold=avg_volume_50 * 1.4,
        initial_stop=initial_stop,
        risk_per_share=risk_per_share,
        risk_pct=risk_pct,
        target1=entry * 1.20,
    )


def position_size(account_size: float, risk_pct_per_trade: float, entry: float, stop: float) -> dict:
    """Sidebar position-sizing helper: given account size, risk % per
    trade, entry, and stop, returns dollar risk, share count, and the
    position's % of account."""
    risk_per_share = entry - stop
    if risk_per_share <= 0:
        return {"dollar_risk": 0.0, "shares": 0, "position_value": 0.0, "pct_of_account": 0.0}

    dollar_risk = account_size * (risk_pct_per_trade / 100)
    shares = int(dollar_risk / risk_per_share)
    position_value = shares * entry
    pct_of_account = (position_value / account_size * 100) if account_size > 0 else 0.0

    return {
        "dollar_risk": dollar_risk,
        "shares": shares,
        "position_value": position_value,
        "pct_of_account": pct_of_account,
    }
