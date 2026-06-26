"""Formatted terminal output for the scanner."""

import textwrap
from datetime import date

from analysis.market_regime import ABORT_THRESHOLD

LINE = "=" * 62
SUBLINE = "  " + "-" * 56

# (label, result key holding the points, max points for that condition)
CONDITIONS = [
    ("C1", "c1_pts", 25),
    ("C2", "c2_pts", 20),
    ("C3", "c3_pts", 25),
    ("C4", "c4_pts", 15),
    ("C5", "c5_pts", 15),
]

# Width of the score bar rendered for each condition in a signal block.
BAR_WIDTH = 25

GRADES_SHOWN = ("A+", "A", "B")

GRADE_EMOJI = {"A+": "✅✅", "A": "✅", "B": "⚠️", "C": "👁", "D/F": "❌"}

# Inner content width of the regime dashboard box (between the "║ " and " ║"
# borders). Matches LINE's overall width of 62.
REGIME_BOX_WIDTH = 58


def format_duration(seconds):
    seconds = max(0, int(seconds))
    minutes, secs = divmod(seconds, 60)
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def _short_label(text):
    """Strip a ' — description' suffix off a regime label string."""
    return text.split(" — ")[0].strip()


def _mark(ok):
    return "✅" if ok else "❌"


def _vix_mark(vix_score):
    """✅ for calm/complacent, ⚠️ for caution/fear, ❌ for panic/crisis."""
    if vix_score >= 20:
        return "✅"
    if vix_score >= 5:
        return "⚠️"
    return "❌"


def _box(lines):
    """Render `lines` inside a double-line box of width REGIME_BOX_WIDTH.

    A `None` entry renders as a horizontal divider (╠...╣).
    """
    width = REGIME_BOX_WIDTH
    out = ["╔" + "═" * (width + 2) + "╗"]
    for line in lines:
        if line is None:
            out.append("╠" + "═" * (width + 2) + "╣")
        else:
            out.append(f"║ {line:<{width}} ║")
    out.append("╚" + "═" * (width + 2) + "╝")
    return out


def _regime_decision_text(regime, force=False):
    score = regime["regime_score"]
    if score < ABORT_THRESHOLD:
        return "⚠️  FORCED — bear market override" if force else "❌ SCAN ABORTED"
    if not regime["show_signals"]:
        return "⚠️  WATCHLIST ONLY — no new longs"
    if regime["position_warning"]:
        return "⚠️  RUNNING SCAN — reduce position sizes 50%"
    return "✅ RUNNING FULL SCAN"


def _regime_status_short(regime, force=False):
    score = regime["regime_score"]
    if score < ABORT_THRESHOLD:
        return "Forced scan (bear override)" if force else "Scan aborted"
    if not regime["show_signals"]:
        return "Watchlist only"
    if regime["position_warning"]:
        return "Reduced size scan"
    return "Full scan active"


def print_regime_dashboard(regime, force=False):
    r = regime

    lines = [
        "📊 MARKET REGIME DASHBOARD".center(REGIME_BOX_WIDTH),
        None,
        f"REGIME SCORE  : {r['regime_score']}/100 — {r['regime_label']} {r['regime_emoji']}",
        f"SCAN DECISION : {_regime_decision_text(r, force)}",
        None,
        f"SPY TREND       [40pts max]              {r['spy_trend_score']}/40",
        f"{_mark(r['spy_above_200'])} SPY ${r['spy_price']:.2f} {'above' if r['spy_above_200'] else 'below'} 200MA ${r['spy_sma200']:.2f}",
        f"{_mark(r['spy_above_50'])} SPY {'above' if r['spy_above_50'] else 'below'} 50MA ${r['spy_sma50']:.2f}",
        f"{_mark(r['golden_cross'])} Golden cross {'active' if r['golden_cross'] else 'inactive'} (50MA {'>' if r['golden_cross'] else '<'} 200MA)",
        f"{_mark(r['spy_above_ema20'])} SPY {'above' if r['spy_above_ema20'] else 'below'} 20 EMA ${r['spy_ema20']:.2f}",
        None,
        f"VIX FEAR GAUGE  [25pts max]              {r['vix_score']}/25",
        f"VIX: {r['vix_current']:.1f} — {_short_label(r['vix_label'])} {_vix_mark(r['vix_score'])} "
        f"(trend: {r['vix_trend']} {_mark(r['vix_trend'] == 'FALLING')})",
        None,
        f"MARKET BREADTH  [20pts max]              {r['breadth_score']}/20",
        f"{_mark(r['iwm_above_200'])} IWM ${r['iwm_price']:.2f} {'above' if r['iwm_above_200'] else 'below'} 200MA ${r['iwm_sma200']:.2f}",
        f"{_mark(r['iwm_above_50'])} IWM {'above' if r['iwm_above_50'] else 'below'} 50MA ${r['iwm_sma50']:.2f}",
        f"{_mark(r['iwm_return_1m'] > 0)} Small caps {'rising' if r['iwm_return_1m'] > 0 else 'falling'} {r['iwm_return_1m']:+.1f}% this month",
        None,
        f"NASDAQ HEALTH   [15pts max]              {r['qqq_score']}/15",
        f"{_mark(r['qqq_above_200'])} QQQ ${r['qqq_price']:.2f} {'above' if r['qqq_above_200'] else 'below'} 200MA ${r['qqq_sma200']:.2f}",
        f"{_mark(r['qqq_above_50'])} QQQ {'above' if r['qqq_above_50'] else 'below'} 50MA ${r['qqq_sma50']:.2f}",
        f"{_mark(r['qqq_return_5d'] > 0)} QQQ {'positive' if r['qqq_return_5d'] > 0 else 'negative'} last 5 days ({r['qqq_return_5d']:+.2f}%)",
    ]

    if r["regime_score"] < ABORT_THRESHOLD:
        lines += [
            None,
            "⚠️  Bear market conditions detected",
            "⚠️  Swing longs have low probability of success",
            "⚠️  Consider: cash, hedges, or inverse ETFs",
            "⚠️  Re-run scanner when SPY reclaims 200MA",
        ]

    print()
    for line in _box(lines):
        print(line)

    for w in r["warnings"]:
        print(f"  ⚠️  {w}")
    if r["vix_elevated"]:
        print("  ⚠️  VIX ELEVATED — reduce all position sizes")
    print()


def _score_bar(points):
    """Render a fixed-width bar showing `points` filled cells out of BAR_WIDTH."""
    filled = max(0, min(BAR_WIDTH, round(points)))
    return "█" * filled + "░" * (BAR_WIDTH - filled)


def _condition_mark(points, max_points):
    if points == 0:
        return "❌"
    if points / max_points >= 0.7:
        return "✅"
    return "⚠️"


def _condition_annotation(label, r):
    if label == "C1":
        return f"gap={r['ema_gap_pct']:+.2f}%"
    if label == "C2":
        return f"{r['price_above_50_pct']:+.2f}% above 50EMA"
    if label == "C3":
        return f"MACD {r['macd_now']:.3f} vs Signal {r['signal_now']:.3f} — {r['macd_signal']}"
    if label == "C4":
        return f"RSI={r['rsi']:.1f}"
    return f"acc={r['acc_score']}/100 {r['phase']} (vol={r['volume_ratio']:.2f}x avg)"


def print_progress_line(i, total, result):
    symbol = result["symbol"]
    grade = result["grade"]
    score = result["score"]
    signal = result["signal"]

    if grade in ("A+", "A"):
        mark = "✅"
    elif grade == "B":
        mark = "⚠️"
    elif grade == "C":
        mark = "👁"
    else:
        mark = "❌"

    c5_mark = _condition_mark(result["c5_pts"], 15)
    print(f"[{i:3d}/{total}] {symbol:<6} {mark} {grade:<3} {signal:<10} | score={score}/100 | C5{c5_mark}(ACC:{result['acc_score']})")


def print_skipped_line(i, total, symbol, reason):
    print(f"[{i:3d}/{total}] {symbol:<6} skipped ({reason})")


def print_progress_summary(signals, watchlist, i, total, elapsed):
    if i == 0:
        eta_str = "—"
    else:
        avg = elapsed / i
        remaining = avg * (total - i)
        eta_str = format_duration(remaining)
    print(f"── Progress: {i}/{total} | Signals: {signals} | Watch: {watchlist} | ETA: {eta_str} ──")


def _print_signal_block(idx, r, regime):
    print(f"  #{idx}  {r['symbol']} — {r['name']}  [Score: {r['score']}/100 — {r['grade']} {r['signal']}] "
          f"[Regime: {regime['regime_label']} {regime['regime_score']}/100]")
    print(f"      Sector  : {r['sector']}")
    print(f"      Price   : ${r['price']:.2f}")
    print()

    for label, key, max_pts in CONDITIONS:
        pts = r[key]
        bar = _score_bar(pts)
        mark = _condition_mark(pts, max_pts)
        annotation = _condition_annotation(label, r)
        print(f"      {label} {mark} [{bar}] {pts:>2}/{max_pts}  {annotation}")

    print(f"      {'-' * 50}")
    print(f"      TOTAL: {r['score']}/100 — {r['grade']} {r['signal']} {GRADE_EMOJI[r['grade']]}")
    print(f"      Position size: {r['position_size_pct']}% of normal")
    print()

    divergence_flag = " ⚠️ DIVERGENCE" if r["ad_divergence"] else ""
    print("      Volume Accumulation:")
    print(f"      OBV      : {r['obv_signal']}")
    print(f"      A/D Line : {r['ad_signal']}{divergence_flag}")
    print(f"      CMF      : {r['cmf_value']:.2f} — {r['cmf_label']}")
    print(f"      Up/Dn Vol: {r['ud_ratio']:.2f}x")
    print(f"      Phase    : {r['phase']}")
    print()

    if r.get("claude_trade") and r["claude_trade"] != "N/A":
        print(f"      Claude: {r['claude_trade']}")
        print(f"      Entry : {r['claude_entry']}")
        print(f"      Stop  : {r['claude_stop']}")
        print(f"      Target: {r['claude_target']}")
        print(f"      Hold  : {r['claude_hold']}")
        wrapped = textwrap.wrap(r["claude_reason"], width=45) or [""]
        print(f"      Reason: {wrapped[0]}")
        for line in wrapped[1:]:
            print(f"              {line}")
    else:
        print("      Claude : N/A")

    if regime["position_warning"]:
        print()
        print("      ⚠️  WEAK BULL MARKET — reduce position size by 50%")
        print("          Normal size: $5,000 → Recommended: $2,500")
        print("          Use tighter stops; take profits earlier (~50% of normal target)")

    if regime["vix_elevated"]:
        print("      ⚠️  VIX ELEVATED — reduce all position sizes")

    print()


def print_results(results, skipped, scanned_total, elapsed, claude_calls, est_cost, regime,
                   min_quality=0, show_watchlist=False, force=False):
    today = date.today().isoformat()

    forced_bear = force and regime["regime_score"] < ABORT_THRESHOLD
    show_signals = regime["show_signals"] or forced_bear
    watchlist_only = not show_signals

    signals = sorted(
        (r for r in results if r["grade"] in GRADES_SHOWN and r["score"] >= min_quality),
        key=lambda r: (-r["score"], -r["volume_ratio"]),
    ) if show_signals else []
    watchlist = [r for r in results if r["grade"] == "C"]

    print()
    print(LINE)
    print(f"  📈 S&P 500 SWING SCANNER — {today}")
    print(f"  🌍 REGIME: {regime['regime_label']} ({regime['regime_score']}/100) {regime['regime_emoji']} "
          f"— {_regime_status_short(regime, force)}")
    print(f"  📊 SPY: ${regime['spy_price']:.2f} {_mark(regime['spy_above_200'])} | "
          f"VIX: {regime['vix_current']:.1f} {_vix_mark(regime['vix_score'])} | "
          f"IWM: {_mark(regime['iwm_above_200'])} | QQQ: {_mark(regime['qqq_above_200'])}")
    if forced_bear:
        print("  ⚠️  FORCED — bear market override")
    print(LINE)
    print(f"  Scanned: {scanned_total} | Signals: {len(signals)} | Watch: {len(watchlist)} | Skipped: {len(skipped)}")
    print(f"  Scan time: {format_duration(elapsed)} | Claude calls: {claude_calls} | Est. cost: ${est_cost:.3f}")
    print(LINE)
    print()

    if watchlist_only:
        print(f"  ⚠️  {regime['regime_label']} REGIME ({regime['regime_score']}/100) — buy signals hidden, watchlist only")
    elif signals:
        print("  ✅ BUY SIGNALS — ranked by score:")
        print(SUBLINE)
        for idx, r in enumerate(signals, start=1):
            _print_signal_block(idx, r, regime)
            print(SUBLINE)
    else:
        print("  No signals today")

    if watchlist and (show_watchlist or watchlist_only):
        print()
        print(SUBLINE)
        print("  👁  WATCHLIST — Grade C (55-64, monitor only):")
        print(SUBLINE)
        for r in sorted(watchlist, key=lambda r: -r["score"]):
            print(f"  {r['symbol']:<6} {r['score']:>3}/100  C  WATCH")
        print(SUBLINE)

    print()
    print(LINE)
    print("  📊 SECTOR BREAKDOWN:")
    sector_counts = {}
    for r in signals:
        sector_counts[r["sector"]] = sector_counts.get(r["sector"], 0) + 1

    if sector_counts:
        for sector, count in sorted(sector_counts.items(), key=lambda x: -x[1]):
            bar = "█" * (count * 2)
            label = "signal" if count == 1 else "signals"
            print(f"  {sector:<24} {bar}  {count} {label}")
    else:
        print("  (none)")

    print()
    print("  📊 MACD BUY/SELL BREAKDOWN (buy signals):")
    macd_counts = {}
    for r in signals:
        macd_counts[r["macd_signal"]] = macd_counts.get(r["macd_signal"], 0) + 1

    if macd_counts:
        for label, count in sorted(macd_counts.items(), key=lambda x: -x[1]):
            noun = "signal" if count == 1 else "signals"
            print(f"  MACD {label:<19} : {count} {noun}")
    else:
        print("  (none)")
    print(LINE)
