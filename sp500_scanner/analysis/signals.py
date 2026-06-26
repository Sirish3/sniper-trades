"""Combines the 5 buy-signal conditions into a single weighted 0-100 score.

C1 (10/20 EMA trend) and C2 (price vs 50 EMA) are hard gates: scoring 0 on
either forces the total score to 0 regardless of C3-C5. C3 (MACD line vs
signal line) is a binary 0/25 buy/sell score. C4 (RSI zone) and C5 (volume)
award partial credit on a sliding scale.
"""

from analysis.ema import calculate_emas
from analysis.macd import calculate_macd, macd_signal_label
from analysis.rsi import calculate_rsi, rsi_zone
from analysis.volume import calculate_volume_ratio, volume_label
from analysis.volume_accumulation import NO_VOLUME_RESULT, evaluate_accumulation

C1_MAX = 25
C2_MAX = 20
C3_MAX = 25
C4_MAX = 15
C5_MAX = 15

# (min score, grade, signal label) — checked high to low.
GRADE_BANDS = [
    (85, "A+", "STRONG BUY"),
    (75, "A", "BUY"),
    (65, "B", "WEAK BUY"),
    (55, "C", "WATCH"),
    (0, "D/F", "SKIP"),
]

POSITION_SIZE_PCT = {"A+": 100, "A": 100, "B": 50, "C": 0, "D/F": 0}


def _score_c1(ema10, ema20, ema_gap_pct):
    """0-25 pts for the 10/20 EMA gap. 0 if ema10 < ema20 (hard gate)."""
    if ema10 < ema20:
        return 0
    if ema_gap_pct > 1.0:
        return 25
    if ema_gap_pct >= 0.5:
        return 22
    return 18


def _score_c2(price, ema50, price_above_50_pct):
    """0-20 pts for how far price is above the 50 EMA. 0 if below (hard gate)."""
    if price < ema50:
        return 0
    if price_above_50_pct > 5:
        return 20
    if price_above_50_pct >= 2:
        return 18
    return 15


def _score_c3(macd_now, signal_now):
    """25 pts if the MACD line is above its signal line (buy), else 0."""
    return 25 if macd_now > signal_now else 0


def _score_c4(rsi_value):
    """0-15 pts for RSI zone."""
    if rsi_value >= 70:
        return 0
    if rsi_value >= 63:
        return 10
    if rsi_value >= 40:
        return 15
    if rsi_value >= 35:
        return 11
    return 6


def _score_c5(acc_score):
    """0-15 pts for the volume accumulation/distribution phase score."""
    if acc_score >= 75:
        return 15
    if acc_score >= 50:
        return 12
    if acc_score >= 30:
        return 8
    if acc_score >= 15:
        return 4
    return 0


def _grade(score):
    for threshold, grade, signal in GRADE_BANDS:
        if score >= threshold:
            return grade, signal
    return "D/F", "SKIP"


def evaluate_signal(company, df):
    """Score all 5 buy-signal conditions for one company on a 0-100 scale.

    `company` is {"symbol", "name", "sector"}. `df` is a cleaned OHLCV
    DataFrame (see data/price_data.py) with at least MIN_BARS rows.
    Returns None if the latest price is 0 (caller should skip the stock).
    """
    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"]
    price = close.iloc[-1]

    if price == 0:
        return None

    emas = calculate_emas(close)
    macd = calculate_macd(close)
    rsi_value = calculate_rsi(close)
    volume_ratio = calculate_volume_ratio(volume)

    ema10, ema20, ema50 = emas["ema10"], emas["ema20"], emas["ema50"]

    ema_gap_pct = (ema10 - ema20) / ema20 * 100
    price_above_50_pct = (price - ema50) / ema50 * 100

    acc = evaluate_accumulation(close, high, low, volume)
    if acc is None:
        c5_pts = 4
        acc = NO_VOLUME_RESULT
    else:
        c5_pts = _score_c5(acc["acc_score"])

    c1_pts = _score_c1(ema10, ema20, ema_gap_pct)
    c2_pts = _score_c2(price, ema50, price_above_50_pct)
    c3_pts = _score_c3(macd["macd_now"], macd["signal_now"])
    c4_pts = _score_c4(rsi_value)

    hard_gate = c1_pts == 0 or c2_pts == 0
    score = 0 if hard_gate else c1_pts + c2_pts + c3_pts + c4_pts + c5_pts
    grade, signal = _grade(score)
    position_size_pct = POSITION_SIZE_PCT[grade]

    return {
        "symbol": company["symbol"],
        "name": company["name"],
        "sector": company["sector"],
        "price": price,
        "ema10": ema10,
        "ema20": ema20,
        "ema50": ema50,
        "ema_gap_pct": ema_gap_pct,
        "price_above_50_pct": price_above_50_pct,
        "macd_now": macd["macd_now"],
        "signal_now": macd["signal_now"],
        "hist_now": macd["hist_now"],
        "macd_signal": macd_signal_label(macd["macd_now"], macd["signal_now"]),
        "rsi": rsi_value,
        "rsi_zone": rsi_zone(rsi_value),
        "volume_ratio": volume_ratio,
        "volume_label": volume_label(volume_ratio),
        "acc_score": acc["acc_score"],
        "phase": acc["phase"],
        "obv_signal": acc["obv_signal"],
        "obv_rising": acc["obv_rising"],
        "obv_new_high": acc["obv_new_high"],
        "ad_signal": acc["ad_signal"],
        "ad_rising": acc["ad_rising"],
        "ad_divergence": acc["ad_divergence"],
        "cmf_value": acc["cmf_value"],
        "cmf_label": acc["cmf_label"],
        "ud_ratio": acc["ud_ratio"],
        "c1_pts": c1_pts,
        "c2_pts": c2_pts,
        "c3_pts": c3_pts,
        "c4_pts": c4_pts,
        "c5_pts": c5_pts,
        "score": score,
        "grade": grade,
        "signal": signal,
        "position_size_pct": position_size_pct,
    }
