"""One-off smoke test: runs the scan pipeline against the 20-ticker test
subset directly (no Streamlit), to confirm data fetching, indicators, the
Trend Template filter, VCP detection, and level calculations all work
end-to-end before pointing this at the full universe."""
from data import get_daily_bars
from indicators import atr, avg_volume
from levels import compute_levels
from screener import check_trend_template, compute_rs_ratios, detect_vcp, rs_percentile_scores

TEST_SUBSET = [
    "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM", "V", "MA",
    "HD", "UNH", "JNJ", "PG", "XOM", "CVX", "WMT", "KO", "PEP", "DIS",
]


def main():
    print(f"Fetching SPY + {len(TEST_SUBSET)} tickers...")
    spy_df = get_daily_bars("SPY", lookback_days=400)
    assert spy_df is not None, "Failed to fetch SPY — check Alpaca credentials in .env"
    print(f"  SPY: {len(spy_df)} bars, {spy_df.index[0].date()} to {spy_df.index[-1].date()}")

    bars_by_symbol = {}
    for symbol in TEST_SUBSET:
        df = get_daily_bars(symbol, lookback_days=400)
        if df is None:
            print(f"  {symbol}: FAILED to fetch")
            continue
        if len(df) < 220:
            print(f"  {symbol}: only {len(df)} bars, skipping (need >=220)")
            continue
        bars_by_symbol[symbol] = df
        print(f"  {symbol}: {len(df)} bars OK")

    print(f"\n{len(bars_by_symbol)}/{len(TEST_SUBSET)} tickers fetched successfully.\n")

    closes_by_symbol = {sym: df["c"] for sym, df in bars_by_symbol.items()}
    rs_ratios = compute_rs_ratios(closes_by_symbol, spy_df["c"])
    rs_scores = rs_percentile_scores(rs_ratios)
    print("RS scores:", {k: round(v, 1) for k, v in sorted(rs_scores.items(), key=lambda kv: -kv[1])})

    print("\n=== Trend Template results ===")
    passed_count = 0
    for symbol, df in bars_by_symbol.items():
        rs = rs_scores.get(symbol)
        trend = check_trend_template(df, rs)
        status = "PASS" if trend.passed else "fail"
        detail = "" if trend.passed else f" ({'; '.join(trend.reasons_failed)})"
        print(f"  [{status}] {symbol:6s} close={trend.close:.2f} rs={trend.rs_score:.0f} "
              f"%off_high={trend.pct_off_high:.1f}%{detail}")
        if trend.passed:
            passed_count += 1

    print(f"\n{passed_count}/{len(bars_by_symbol)} passed the Trend Template.\n")

    print("=== VCP detection (Trend Template passes only) ===")
    for symbol, df in bars_by_symbol.items():
        rs = rs_scores.get(symbol)
        trend = check_trend_template(df, rs)
        if not trend.passed:
            continue

        vcp = detect_vcp(df)
        atr14 = atr(df, 14).iloc[-1]
        vol50 = avg_volume(df["v"], 50).iloc[-1]

        if vcp.detected:
            levels = compute_levels(vcp.pivot, atr14, vol50)
            print(f"  {symbol}: VCP CONFIRMED  pivot={vcp.pivot:.2f}  entry={levels.entry_trigger:.2f}  "
                  f"stop={levels.initial_stop:.2f}  risk={levels.risk_per_share:.2f} ({levels.risk_pct:.1f}%)  "
                  f"target={levels.target1:.2f}")
        else:
            print(f"  {symbol}: Trend OK, no VCP yet — {vcp.reason}")

    print("\nPipeline test complete.")


if __name__ == "__main__":
    main()
