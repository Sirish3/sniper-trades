"""S&P 500 Swing Scanner — entry point and scanning engine.

Usage:
    python main.py                          Scan all S&P 500 tickers
    python main.py AAPL MSFT NVDA            Scan only these tickers
    python main.py --sector "Health Care"    Scan only one GICS sector
    python main.py --top 100                 Scan only the first N tickers
    python main.py --watchlist               Also print the Grade C (55-64) watchlist
    python main.py --no-claude               Skip Claude Haiku analysis
    python main.py --min-quality 80          Only report signals with score >= 80
    python main.py --regime-only             Only print the market regime dashboard
    python main.py --force                   Run the scan even in a bear market
    python main.py --regime-threshold 60     Override the min regime score to run (default 55)
"""

import argparse
import time

from dotenv import load_dotenv

import claude_ai
from analysis import market_regime
from analysis.signals import evaluate_signal
from data.price_data import fetch_all
from data.sp500_tickers import get_sp500_tickers
from output import export, printer

PROGRESS_INTERVAL = 25


def parse_args():
    parser = argparse.ArgumentParser(description="S&P 500 swing trading scanner")
    parser.add_argument("tickers", nargs="*", help="Scan only these tickers")
    parser.add_argument("--sector", help="Scan only this GICS sector")
    parser.add_argument("--top", type=int, help="Scan only the first N tickers")
    parser.add_argument("--watchlist", action="store_true", help="Also print the Grade C (55-64) watchlist in the report")
    parser.add_argument("--no-claude", action="store_true", help="Skip Claude Haiku analysis")
    parser.add_argument("--min-quality", type=int, default=0, help="Only report buy signals with score >= this")
    parser.add_argument("--regime-only", action="store_true", help="Only print the market regime dashboard, skip the ticker scan")
    parser.add_argument("--force", action="store_true", help="Run the scan even if the market regime is a bear market")
    parser.add_argument("--regime-threshold", type=int, default=market_regime.RUN_SCAN_THRESHOLD_DEFAULT,
                         help=f"Minimum regime score required to run the scan and show signals (default {market_regime.RUN_SCAN_THRESHOLD_DEFAULT})")
    return parser.parse_args()


def build_universe(companies, args):
    """Resolve CLI args into the list of {"symbol", "name", "sector"} to scan."""
    if args.tickers:
        by_symbol = {c["symbol"]: c for c in companies}
        universe = []
        for raw in args.tickers:
            symbol = raw.strip().upper().replace(".", "-")
            universe.append(by_symbol.get(symbol, {"symbol": symbol, "name": symbol, "sector": "Unknown"}))
        return universe

    universe = companies

    if args.sector:
        matches = [c for c in companies if c["sector"].lower() == args.sector.lower()]
        if not matches:
            print(f"❌ Unknown sector '{args.sector}'. Valid sectors:")
            for sector in sorted({c["sector"] for c in companies}):
                print(f"   - {sector}")
            raise SystemExit(1)
        universe = matches

    if args.top:
        universe = universe[: args.top]

    return universe


def check_regime(args):
    """Run the market regime check and print the dashboard.

    Returns (regime, forced_bear) on success. Exits the program if SPY data
    can't be fetched, or if the market is in a bear regime and --force
    wasn't passed (the regime log is still written in that case).
    """
    print("Checking market regime...")
    try:
        regime = market_regime.check_market_regime(threshold=args.regime_threshold)
    except market_regime.RegimeDataError as exc:
        print(f"❌ {exc}")
        raise SystemExit(1)

    printer.print_regime_dashboard(regime, force=args.force)

    aborted = regime["regime_score"] < market_regime.ABORT_THRESHOLD
    forced_bear = aborted and args.force

    if aborted and not args.force:
        print("❌ BEAR MARKET DETECTED — scan aborted")
        print(f"Regime score: {regime['regime_score']}/100 — {regime['regime_label']}")
        print("Reason: SPY trend and/or VIX indicate unhealthy market conditions")
        export.export_regime_log(regime)
        raise SystemExit(0)

    if forced_bear:
        print("⚠️  FORCED — bear market override (--force)")
    elif not regime["show_signals"]:
        print(f"⚠️  {regime['regime_label']} MARKET — showing watchlist only, no new longs")
    elif regime["position_warning"]:
        print(f"⚠️  {regime['regime_label']} — scan running, reduce position sizes by 50%")
    else:
        print(f"✅ {regime['regime_label']} CONFIRMED — running full scan")

    return regime, forced_bear


def main():
    load_dotenv()
    args = parse_args()

    regime, forced_bear = check_regime(args)

    if args.regime_only:
        export.export_regime_log(regime)
        raise SystemExit(0)

    companies = get_sp500_tickers()
    universe = build_universe(companies, args)
    total = len(universe)

    print(f"\nFetching price data for {total} ticker{'s' if total != 1 else ''}...\n")
    price_data = fetch_all([c["symbol"] for c in universe])

    results = []
    skipped = []
    signals_found = 0
    watchlist_found = 0
    claude_calls = 0

    started_at = time.time()

    for i, company in enumerate(universe, start=1):
        symbol = company["symbol"]
        df = price_data.get(symbol)

        if df is None:
            printer.print_skipped_line(i, total, symbol, "insufficient history")
            skipped.append(symbol)
        else:
            result = evaluate_signal(company, df)

            if result is None:
                printer.print_skipped_line(i, total, symbol, "invalid price")
                skipped.append(symbol)
                continue

            if result["grade"] in ("A+", "A", "B") and not args.no_claude:
                result.update(claude_ai.get_trade_review(result, regime))
                claude_calls += 1

            if result["grade"] in ("A+", "A", "B"):
                signals_found += 1
            elif result["grade"] == "C":
                watchlist_found += 1

            results.append(result)
            printer.print_progress_line(i, total, result)

        if i % PROGRESS_INTERVAL == 0 or i == total:
            printer.print_progress_summary(signals_found, watchlist_found, i, total, time.time() - started_at)

    elapsed = time.time() - started_at
    est_cost = claude_calls * claude_ai.EST_COST_PER_CALL

    printer.print_results(
        results, skipped, total, elapsed, claude_calls, est_cost, regime,
        min_quality=args.min_quality, show_watchlist=args.watchlist, force=forced_bear,
    )
    export.export_results(results, regime)
    export.export_regime_log(regime)


if __name__ == "__main__":
    main()
