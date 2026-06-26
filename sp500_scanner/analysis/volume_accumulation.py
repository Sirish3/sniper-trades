"""Volume accumulation/distribution phase detection.

Scores how much a stock is being accumulated or distributed by combining
four volume-based indicators into a single 0-100 "accumulation score": On
Balance Volume (OBV), the Accumulation/Distribution (A/D) line, Chaikin
Money Flow (CMF), and the up/down volume ratio. analysis/signals.py uses
this score (instead of a raw single-day volume ratio) to award C5 points.
"""

OBV_LOOKBACK = 20
AD_SMA_PERIOD = 20
CMF_PERIOD = 20
UD_VOLUME_PERIOD = 10

# (min score, phase label) — checked high to low.
PHASE_BANDS = [
    (75, "STRONG ACCUMULATION ✅✅"),
    (50, "ACCUMULATION ✅"),
    (30, "MILD ACCUMULATION ⚠️"),
    (15, "NEUTRAL"),
    (0, "DISTRIBUTION ❌"),
]

# Returned by analysis.signals when total volume is 0 (e.g. a halted
# ticker) — signals.py treats this as "skip accumulation" and awards a
# flat, neutral C5 score instead of computing one from these fields.
NO_VOLUME_RESULT = {
    "acc_score": 0,
    "phase": "N/A — no volume data",
    "obv_signal": "N/A",
    "obv_rising": False,
    "obv_new_high": False,
    "ad_signal": "N/A",
    "ad_rising": False,
    "ad_divergence": False,
    "cmf_value": 0.0,
    "cmf_label": "N/A",
    "ud_ratio": 0.0,
}


def _phase_label(score):
    for threshold, label in PHASE_BANDS:
        if score >= threshold:
            return label
    return "DISTRIBUTION ❌"


def _money_flow_volume(close, high, low, volume):
    """Per-bar money flow volume, shared by the A/D line and CMF.

    `mfm = ((close - low) - (high - close)) / (high - low)`, with mfm = 0
    on bars where high == low (no range, avoids division by zero).
    """
    price_range = high - low
    safe_range = price_range.where(price_range != 0, 1)
    mfm = ((close - low) - (high - close)).where(price_range != 0, 0) / safe_range
    return mfm * volume


def _score_obv(close, volume):
    """0-30 pts from On Balance Volume direction, 20-day high, and SMA20."""
    if len(close) < 10:
        return {"points": 0, "signal": "insufficient data — skipped", "rising": False, "new_high": False}

    direction = close.diff().apply(lambda x: 1 if x > 0 else (-1 if x < 0 else 0))
    obv = (volume * direction).cumsum()

    rising = obv.iloc[-1] > obv.iloc[-2]

    lookback = min(OBV_LOOKBACK, len(obv))
    new_high = obv.iloc[-1] == obv.iloc[-lookback:].max()

    if len(obv) >= OBV_LOOKBACK:
        above_sma = obv.iloc[-1] > obv.rolling(OBV_LOOKBACK).mean().iloc[-1]
    else:
        above_sma = False

    if new_high:
        return {"points": 30, "signal": "NEW 20-DAY HIGH — strong accumulation", "rising": rising, "new_high": new_high}
    if above_sma and rising:
        return {"points": 22, "signal": "RISING above its 20-day average — accumulating", "rising": rising, "new_high": new_high}
    if rising:
        return {"points": 12, "signal": "RISING — mild accumulation", "rising": rising, "new_high": new_high}
    return {"points": 0, "signal": "FLAT/FALLING — no accumulation", "rising": rising, "new_high": new_high}


def _score_ad(close, high, low, volume):
    """0-30 pts from the Accumulation/Distribution line direction and divergence."""
    ad = _money_flow_volume(close, high, low, volume).cumsum()

    rising = ad.iloc[-1] > ad.iloc[-2]
    price_falling = close.iloc[-1] < close.iloc[-2]
    divergence = price_falling and rising

    if len(ad) >= AD_SMA_PERIOD:
        above_sma = ad.iloc[-1] > ad.rolling(AD_SMA_PERIOD).mean().iloc[-1]
    else:
        above_sma = False

    if divergence:
        return {"points": 30, "signal": "BULLISH DIVERGENCE — price down, money flow up", "rising": rising, "divergence": divergence}
    if rising and above_sma:
        return {"points": 22, "signal": "RISING above its 20-day average — accumulating", "rising": rising, "divergence": divergence}
    if rising:
        return {"points": 12, "signal": "RISING — mild accumulation", "rising": rising, "divergence": divergence}
    return {"points": 0, "signal": "FLAT/FALLING — no accumulation", "rising": rising, "divergence": divergence}


def _score_cmf(close, high, low, volume):
    """Chaikin Money Flow: -10 to +25 pts based on a 20-day money flow average."""
    mfv = _money_flow_volume(close, high, low, volume)

    period = min(CMF_PERIOD, len(volume))
    vol_sum = volume.iloc[-period:].sum()
    cmf = mfv.iloc[-period:].sum() / vol_sum if vol_sum else 0.0

    if cmf > 0.25:
        return cmf, 25, "STRONG ACCUMULATION"
    if cmf > 0.10:
        return cmf, 18, "ACCUMULATION"
    if cmf > 0:
        return cmf, 8, "MILD"
    if cmf < -0.10:
        return cmf, -10, "DISTRIBUTION"
    return cmf, 0, "NEUTRAL"


def _score_up_down_volume(close, volume):
    """0-15 pts from the ratio of average volume on up days vs down days."""
    period = min(UD_VOLUME_PERIOD, len(close) - 1)
    changes = close.diff().iloc[-period:]
    vols = volume.iloc[-period:]

    up_vols = vols[changes > 0]
    down_vols = vols[changes < 0]

    up_vol = up_vols.mean() if len(up_vols) else 0.0
    down_vol = down_vols.mean() if len(down_vols) else 0.0

    ratio = 2.0 if down_vol == 0 else up_vol / down_vol

    if ratio > 2.0:
        return ratio, 15
    if ratio > 1.5:
        return ratio, 10
    if ratio > 1.0:
        return ratio, 5
    return ratio, 0


def evaluate_accumulation(close, high, low, volume):
    """Score the volume accumulation/distribution phase for one stock.

    `close`/`high`/`low`/`volume` are pandas Series, oldest first. Returns
    None if total volume is 0, so the caller can fall back to a flat,
    neutral C5 score (see NO_VOLUME_RESULT).
    """
    if volume.sum() == 0:
        return None

    obv = _score_obv(close, volume)
    ad = _score_ad(close, high, low, volume)
    cmf_value, cmf_pts, cmf_label = _score_cmf(close, high, low, volume)
    ud_ratio, ud_pts = _score_up_down_volume(close, volume)

    acc_score = max(0, min(100, obv["points"] + ad["points"] + cmf_pts + ud_pts))

    return {
        "acc_score": acc_score,
        "phase": _phase_label(acc_score),
        "obv_signal": obv["signal"],
        "obv_rising": obv["rising"],
        "obv_new_high": obv["new_high"],
        "ad_signal": ad["signal"],
        "ad_rising": ad["rising"],
        "ad_divergence": ad["divergence"],
        "cmf_value": cmf_value,
        "cmf_label": cmf_label,
        "ud_ratio": ud_ratio,
    }
