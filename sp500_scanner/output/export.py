"""Save scan results to CSV files."""

import csv
import os
from datetime import date, datetime

LINE = "=" * 62

# Regime fields copied onto every row of signals/watchlist/full_scan CSVs.
REGIME_RESULT_COLUMNS = [
    "regime_score", "regime_label",
    "spy_price", "spy_above_200", "spy_above_50",
    "golden_cross", "vix_current", "vix_label",
    "vix_trend", "iwm_above_200", "breadth_label",
    "qqq_above_200",
]

SIGNAL_COLUMNS = [
    "symbol", "name", "sector", "price",
    "ema10", "ema20", "ema50", "ema_gap_pct",
    "price_above_50_pct",
    "macd_now", "signal_now", "hist_now", "macd_signal",
    "rsi", "rsi_zone", "volume_ratio", "volume_label",
    "acc_score", "phase", "obv_rising", "obv_new_high",
    "ad_rising", "ad_divergence", "cmf_value", "ud_ratio",
    "c1_pts", "c2_pts", "c3_pts", "c4_pts", "c5_pts",
    "score", "grade", "signal", "position_size_pct",
    "claude_trade", "claude_entry", "claude_stop",
    "claude_target", "claude_hold", "claude_reason",
] + REGIME_RESULT_COLUMNS

# Full regime snapshot — one row per scan, appended over time.
REGIME_LOG_COLUMNS = [
    "timestamp", "regime_score", "regime_label",
    "run_scan", "show_signals", "position_warning", "vix_elevated",
    "spy_price", "spy_sma50", "spy_sma200", "spy_ema20",
    "spy_above_200", "spy_above_50", "spy_above_ema20", "golden_cross",
    "spy_trend_score", "spy_trend_label",
    "vix_current", "vix_sma20", "vix_trend", "vix_score", "vix_label",
    "iwm_price", "iwm_sma50", "iwm_sma200", "iwm_above_200", "iwm_above_50",
    "iwm_return_1m", "breadth_score", "breadth_label",
    "qqq_price", "qqq_sma50", "qqq_sma200", "qqq_above_200", "qqq_above_50",
    "qqq_return_5d", "qqq_score",
]

NA_DEFAULTS = {
    "claude_trade": "N/A",
    "claude_entry": "N/A",
    "claude_stop": "N/A",
    "claude_target": "N/A",
    "claude_hold": "N/A",
    "claude_reason": "N/A",
}


def _row(result, regime, columns):
    row = {}
    for col in columns:
        if col in REGIME_RESULT_COLUMNS:
            row[col] = regime.get(col, "")
        else:
            row[col] = result.get(col, NA_DEFAULTS.get(col, ""))
    return row


def _write_csv(filename, results, regime, columns):
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        for r in results:
            writer.writerow(_row(r, regime, columns))


def export_results(results, regime):
    """Write signals_{date}.csv, watchlist_{date}.csv, and full_scan_{date}.csv.

    Every row also carries the current market regime snapshot (see
    REGIME_RESULT_COLUMNS). Prints a confirmation line for each file written.
    """
    today = date.today().isoformat()

    signals = [r for r in results if r["grade"] in ("A+", "A", "B")]
    watchlist = [r for r in results if r["grade"] == "C"]

    signals_file = f"signals_{today}.csv"
    watchlist_file = f"watchlist_{today}.csv"
    full_file = f"full_scan_{today}.csv"

    _write_csv(signals_file, signals, regime, SIGNAL_COLUMNS)
    _write_csv(watchlist_file, watchlist, regime, SIGNAL_COLUMNS)
    _write_csv(full_file, results, regime, SIGNAL_COLUMNS)

    print(LINE)
    print(f"  💾 {signals_file:<28} ({len(signals)} rows)")
    print(f"  💾 {watchlist_file:<28} ({len(watchlist)} rows)")
    print(f"  💾 {full_file:<28} ({len(results)} rows)")
    print(LINE)


def export_regime_log(regime):
    """Append a snapshot of `regime` to regime_log_{date}.csv.

    Called after every run regardless of outcome (full scan, watchlist-only,
    or abort) so regime changes can be tracked over time. Writes the header
    only if the file doesn't already exist.
    """
    today = date.today().isoformat()
    filename = f"regime_log_{today}.csv"

    row = {col: regime.get(col, "") for col in REGIME_LOG_COLUMNS}
    row["timestamp"] = datetime.now().isoformat(timespec="seconds")

    file_exists = os.path.exists(filename)
    with open(filename, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=REGIME_LOG_COLUMNS)
        if not file_exists:
            writer.writeheader()
        writer.writerow(row)

    print(f"  💾 {filename:<28} (regime snapshot appended)")
