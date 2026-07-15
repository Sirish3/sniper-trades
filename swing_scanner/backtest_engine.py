"""Walks real daily OHLCV bars, date-major across a ticker universe, running
any subset of {pullback_ma, base_breakout, earnings_gap} through the shared
check_setup/check_entry/check_exit interface (see strategies/), with shared
risk-based position sizing and portfolio constraints layered on top. No
look-ahead: a decision made "on day i" only ever reads bars up to and
including index i.

fill_timing ('close' | 'next_open', see strategies/params.py::PortfolioParams)
applies only to ENTRY fills, via strategies/utils.py::entry_fill() — the one
generic, config-driven fill point. Every exit (stop/target/trail/time) fills
at the price its own rule defines (the stop level, the target level, or that
bar's close — the spec says "exit at market close" for both the EMA trail
and the time stop, so those are always close-based regardless of the entry
fill_timing setting), since those are real order-trigger prices, not a
matter of execution-timing preference.

Two-layer design: each strategy file is a pure function of (df, i, ...) with
no knowledge of other tickers, equity, or position limits. This module is
the only place that owns the shared equity pool, the max-concurrent-
positions/one-per-ticker constraints, and the day-by-day walk that makes
those constraints meaningful across tickers.
"""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass, replace

import pandas as pd

from data import get_daily_bars
from strategies import DEFAULT_PARAMS, STRATEGIES
from strategies.earnings_calendar import EarningsCalendar
from strategies.params import PortfolioParams
from strategies.types import ExitSignal, Position
from strategies.utils import apply_slippage, entry_fill, position_size

logger = logging.getLogger(__name__)

WARMUP_BUFFER_DAYS = 300  # calendar days of extra history fetched before start_date, for SMA200/base-window warmup


@dataclass
class Trade:
    ticker: str
    strategy_id: str
    setup_date: pd.Timestamp
    entry_date: pd.Timestamp
    entry_price: float
    stop_price: float
    exit_date: pd.Timestamp
    exit_price: float
    exit_reason: str
    shares: float
    r_multiple: float
    holding_days: int

    def to_row(self) -> dict:
        return {
            "ticker": self.ticker, "strategy": self.strategy_id,
            "setup_date": self.setup_date.date().isoformat(),
            "entry_date": self.entry_date.date().isoformat(), "entry_price": round(self.entry_price, 4),
            "stop_price": round(self.stop_price, 4),
            "exit_date": self.exit_date.date().isoformat(), "exit_price": round(self.exit_price, 4),
            "exit_reason": self.exit_reason, "shares": round(self.shares, 4),
            "r_multiple": round(self.r_multiple, 3), "holding_days": self.holding_days,
        }


@dataclass
class Funnel:
    setups_found: int = 0
    entries_triggered: int = 0
    entries_skipped_earnings: int = 0


@dataclass
class StrategyStats:
    strategy_id: str
    total_return_pct: float
    cagr_pct: float
    win_rate_pct: float
    avg_r_multiple: float
    profit_factor: float
    max_drawdown_pct: float
    num_trades: int
    avg_holding_days: float
    setups_found: int
    entries_triggered: int
    entries_skipped_earnings: int


@dataclass
class SimResult:
    trades: list[Trade]
    funnel: dict[str, Funnel]
    equity_curve: pd.Series
    starting_equity: float


class _TickerStrategyState:
    """State machine for one (ticker, strategy) pair: flat -> setup pending
    -> position open -> flat. Holds the strategy-augmented DataFrame so
    prepare() runs exactly once per (ticker, strategy)."""

    def __init__(self, ticker: str, strategy_id: str, df: pd.DataFrame, params):
        self.ticker = ticker
        self.strategy_id = strategy_id
        self.module = STRATEGIES[strategy_id]
        self.df = self.module.prepare(df)
        self.params = params
        self.setup_state = None
        self.position: Position | None = None


def _to_naive(df: pd.DataFrame) -> pd.DataFrame:
    """Alpaca's bar timestamps parse to tz-aware UTC (data.py's pd.to_datetime
    on a "...Z" string); start_date/end_date come from plain "YYYY-MM-DD"
    request params and are tz-naive. Comparing the two raises "Cannot compare
    tz-naive and tz-aware timestamps", so every fetch is normalized to naive
    here, once, right after it comes back — before any date comparison
    touches it — so the rest of this module (and the strategy files, whose
    own tests assume naive dates) can stay tz-agnostic."""
    return df.tz_localize(None) if df.index.tz is not None else df


def _fetch_with_enough_history(ticker: str, start_date: pd.Timestamp, end_date: pd.Timestamp) -> pd.DataFrame | None:
    lookback_days = (pd.Timestamp.today() - start_date).days + WARMUP_BUFFER_DAYS
    df = get_daily_bars(ticker, lookback_days=lookback_days, use_cache=True)
    if df is not None and not df.empty:
        df = _to_naive(df)
    # get_daily_bars caches one file per symbol per day regardless of the
    # lookback_days requested — a same-day cache hit from a smaller earlier
    # fetch (e.g. the live scanner's default 400-day pull) would silently
    # truncate a multi-year backtest. Detect that and force a fresh pull.
    if df is not None and not df.empty and df.index.min() > start_date - pd.Timedelta(days=30):
        df = get_daily_bars(ticker, lookback_days=lookback_days, use_cache=False)
        if df is not None and not df.empty:
            df = _to_naive(df)
    if df is None or df.empty:
        return None
    return df[df.index <= end_date]


def _load_universe(tickers: list[str], start_date: pd.Timestamp, end_date: pd.Timestamp) -> dict[str, pd.DataFrame]:
    bars = {}
    for ticker in tickers:
        df = _fetch_with_enough_history(ticker, start_date, end_date)
        if df is None:
            logger.warning("No data for %s — skipping", ticker)
            continue
        bars[ticker] = df
    return bars


class _PortfolioBook:
    """Shared, mutable across every (ticker, strategy) state — the only way
    "max N concurrent positions total" and "max 1 open position per ticker"
    (both cross-ticker, cross-strategy rules) can be enforced, since each
    strategy file only ever sees its own single ticker's DataFrame."""

    def __init__(self, max_concurrent: int):
        self.max_concurrent = max_concurrent
        self.open_count = 0
        self.tickers_open: set[str] = set()

    def can_open(self, ticker: str) -> bool:
        return ticker not in self.tickers_open and self.open_count < self.max_concurrent

    def on_open(self, ticker: str) -> None:
        self.open_count += 1
        self.tickers_open.add(ticker)

    def on_close(self, ticker: str) -> None:
        self.open_count -= 1
        self.tickers_open.discard(ticker)


def _open_position(state: _TickerStrategyState, setup_state, entry_signal, i: int, portfolio: PortfolioParams,
                    equity: float, book: _PortfolioBook) -> Position | None:
    if not book.can_open(state.ticker):
        return None
    fill = entry_fill(state.df, entry_signal.trigger_index, portfolio.fill_timing)
    if fill is None:
        return None
    fill_index, raw_price = fill
    entry_price = apply_slippage(raw_price, portfolio.slippage_pct, "buy")
    stop_price = entry_signal.stop_price
    shares = position_size(equity, portfolio.risk_pct_per_trade, entry_price, stop_price)
    if shares <= 0:
        return None
    return Position(
        strategy_id=state.strategy_id, ticker=state.ticker, entry_index=fill_index,
        entry_price=entry_price, stop_price=stop_price, target_price=entry_signal.target_price, shares=shares,
        stage_data={"initial_risk": entry_price - stop_price, "setup_date": state.df.index[setup_state.anchor_index]},
    )


def _close_position(state: _TickerStrategyState, exit_signal, equity: float, portfolio: PortfolioParams) -> tuple[Trade, float]:
    position = state.position
    exit_price = apply_slippage(exit_signal.exit_price, portfolio.slippage_pct, "sell")
    pnl_per_share = exit_price - position.entry_price
    # Commission is a flat fee per side (not a per-share price adjustment),
    # so it comes off realized P&L directly rather than distorting entry/exit price.
    commission_total = portfolio.commission_per_side * 2
    initial_risk = position.stage_data.get("initial_risk") or 1e-9
    trade = Trade(
        ticker=state.ticker, strategy_id=state.strategy_id, setup_date=position.stage_data["setup_date"],
        entry_date=state.df.index[position.entry_index], entry_price=position.entry_price, stop_price=position.stop_price,
        exit_date=state.df.index[exit_signal.exit_index], exit_price=exit_price, exit_reason=exit_signal.reason,
        shares=position.shares, r_multiple=pnl_per_share / initial_risk,
        holding_days=exit_signal.exit_index - position.entry_index,
    )
    new_equity = equity + pnl_per_share * position.shares - commission_total
    return trade, new_equity


def _simulate(strategy_ids: list[str], tickers: list[str], start_date: str, end_date: str,
              strategy_params: dict | None = None, portfolio: PortfolioParams | None = None,
              earnings_calendar: EarningsCalendar | None = None) -> SimResult:
    portfolio = portfolio or PortfolioParams()
    start_ts, end_ts = pd.Timestamp(start_date), pd.Timestamp(end_date)
    strategy_params = strategy_params or {}

    bars = _load_universe(tickers, start_ts, end_ts)
    states: dict[tuple[str, str], _TickerStrategyState] = {}
    for ticker, df in bars.items():
        for sid in strategy_ids:
            base_params = strategy_params.get(sid, DEFAULT_PARAMS[sid])
            # Each ticker gets its OWN params copy — base_params may be the
            # module-level DEFAULT_PARAMS singleton (or a shared instance
            # passed by the caller for one run), and setting .ticker on a
            # shared instance across the ticker loop would leave every
            # ticker's state pointing at whichever one was set last.
            params = replace(base_params) if hasattr(base_params, "ticker") else base_params
            if hasattr(params, "ticker"):
                params.ticker = ticker
                params.earnings_calendar = earnings_calendar
            states[(ticker, sid)] = _TickerStrategyState(ticker, sid, df, params)

    master_dates = sorted({d for df in bars.values() for d in df.index if start_ts <= d <= end_ts})
    date_to_pos = {ticker: {d: idx for idx, d in enumerate(df.index)} for ticker, df in bars.items()}

    equity = portfolio.account_equity
    trades: list[Trade] = []
    funnel = {sid: Funnel() for sid in strategy_ids}
    book = _PortfolioBook(portfolio.max_concurrent_positions)
    equity_by_date: dict[pd.Timestamp, float] = {}

    for d in master_dates:
        for ticker in tickers:
            pos_map = date_to_pos.get(ticker)
            if pos_map is None or d not in pos_map:
                continue
            i = pos_map[d]
            for sid in strategy_ids:
                state = states[(ticker, sid)]
                module = state.module

                if state.position is not None:
                    exit_signal = module.check_exit(state.df, i, state.position, state.params)
                    if exit_signal is not None:
                        trade, equity = _close_position(state, exit_signal, equity, portfolio)
                        trades.append(trade)
                        book.on_close(ticker)
                        state.position = None
                    continue

                if state.setup_state is not None:
                    entry_signal = module.check_entry(state.df, i, state.setup_state, state.params)
                    state.setup_state = _handle_entry_signal(
                        state, entry_signal, state.setup_state, i, portfolio, equity, funnel[sid], book,
                    )
                    continue

                new_setup = module.check_setup(state.df, i, state.params)
                if new_setup is None:
                    continue
                funnel[sid].setups_found += 1
                entry_signal = module.check_entry(state.df, i, new_setup, state.params)
                state.setup_state = _handle_entry_signal(state, entry_signal, new_setup, i, portfolio, equity, funnel[sid], book)

        equity_by_date[d] = equity + sum(
            (state.position.shares * (state.df["c"].iloc[date_to_pos[state.ticker][d]] - state.position.entry_price))
            for state in states.values()
            if state.position is not None and d in date_to_pos.get(state.ticker, {})
        )

    # Force-close anything still open at the end of the window, mark-to-market
    # at the last available close, so final equity/stats reflect them.
    for state in states.values():
        if state.position is None:
            continue
        last_i = len(state.df) - 1
        last_close = float(state.df["c"].iloc[last_i])
        trade, equity = _close_position(state, ExitSignal(exit_index=last_i, exit_price=last_close, reason="end_of_backtest"),
                                          equity, portfolio)
        trades.append(trade)

    equity_curve = pd.Series(equity_by_date).sort_index() if equity_by_date else pd.Series([portfolio.account_equity])
    return SimResult(trades=trades, funnel=funnel, equity_curve=equity_curve, starting_equity=portfolio.account_equity)


def _handle_entry_signal(state, entry_signal, setup_state, i, portfolio, equity, funnel_entry, book):
    """Returns the setup_state that should remain pending (None if it
    triggered a position or expired)."""
    if entry_signal is not None:
        if entry_signal.skipped:
            funnel_entry.entries_skipped_earnings += 1
        else:
            position = _open_position(state, setup_state, entry_signal, i, portfolio, equity, book)
            if position is not None:
                state.position = position
                book.on_open(state.ticker)
                funnel_entry.entries_triggered += 1
                return None
    if setup_state.expires_index is not None and i >= setup_state.expires_index:
        return None  # expired without triggering
    return setup_state


def compute_stats(strategy_id: str, trades: list[Trade], starting_equity: float, equity_curve: pd.Series,
                   funnel: Funnel) -> StrategyStats:
    """`trades` must already be filtered to whatever this stats row should
    cover — a single strategy's trades for a per-strategy row, or every
    trade for the "combined" row. (Trades never carry strategy_id=="combined"
    themselves, so filtering by strategy_id here would silently zero out
    the combined row.)"""
    my_trades = trades
    n = len(my_trades)
    final_equity = float(equity_curve.iloc[-1]) if len(equity_curve) else starting_equity
    total_return_pct = (final_equity / starting_equity - 1) * 100 if starting_equity else 0.0

    if len(equity_curve) >= 2:
        days = max((equity_curve.index[-1] - equity_curve.index[0]).days, 1)
        cagr_pct = ((final_equity / starting_equity) ** (365.0 / days) - 1) * 100 if starting_equity > 0 else 0.0
        drawdown = equity_curve / equity_curve.cummax() - 1
        max_drawdown_pct = float(drawdown.min()) * 100
    else:
        cagr_pct = 0.0
        max_drawdown_pct = 0.0

    wins = [t for t in my_trades if t.r_multiple > 0]
    gains = sum(t.r_multiple for t in my_trades if t.r_multiple > 0)
    losses = abs(sum(t.r_multiple for t in my_trades if t.r_multiple < 0))

    return StrategyStats(
        strategy_id=strategy_id,
        total_return_pct=total_return_pct,
        cagr_pct=cagr_pct,
        win_rate_pct=(len(wins) / n * 100) if n else 0.0,
        avg_r_multiple=(sum(t.r_multiple for t in my_trades) / n) if n else 0.0,
        profit_factor=(gains / losses) if losses > 0 else (float("inf") if gains > 0 else 0.0),
        max_drawdown_pct=max_drawdown_pct,
        num_trades=n,
        avg_holding_days=(sum(t.holding_days for t in my_trades) / n) if n else 0.0,
        setups_found=funnel.setups_found,
        entries_triggered=funnel.entries_triggered,
        entries_skipped_earnings=funnel.entries_skipped_earnings,
    )


def run_comparison(strategy_ids: list[str], tickers: list[str], start_date: str, end_date: str,
                    strategy_params: dict | None = None, portfolio_params: PortfolioParams | None = None,
                    earnings_calendar: EarningsCalendar | None = None) -> dict:
    """Runs each selected strategy in isolation (its own starting equity,
    own position-limit pool) for per-strategy stats, then all of them
    together sharing one equity/position pool for combined stats — the
    side-by-side comparison this module exists for."""
    portfolio_params = portfolio_params or PortfolioParams()
    per_strategy_stats: dict[str, StrategyStats] = {}
    all_trades: list[Trade] = []

    for sid in strategy_ids:
        result = _simulate([sid], tickers, start_date, end_date, strategy_params, portfolio_params, earnings_calendar)
        per_strategy_stats[sid] = compute_stats(sid, result.trades, result.starting_equity, result.equity_curve, result.funnel[sid])
        all_trades.extend(result.trades)

    if len(strategy_ids) > 1:
        combined_result = _simulate(strategy_ids, tickers, start_date, end_date, strategy_params, portfolio_params, earnings_calendar)
        combined_trades = combined_result.trades
        combined_funnel = Funnel(
            setups_found=sum(f.setups_found for f in combined_result.funnel.values()),
            entries_triggered=sum(f.entries_triggered for f in combined_result.funnel.values()),
            entries_skipped_earnings=sum(f.entries_skipped_earnings for f in combined_result.funnel.values()),
        )
        combined_stats = compute_stats("combined", combined_trades, combined_result.starting_equity,
                                        combined_result.equity_curve, combined_funnel)
    else:
        sid = strategy_ids[0]
        combined_trades = all_trades
        combined_stats = per_strategy_stats[sid]

    return {"per_strategy": per_strategy_stats, "combined": combined_stats, "trades": combined_trades}


def trades_to_csv(trades: list[Trade]) -> str:
    buf = io.StringIO()
    pd.DataFrame([t.to_row() for t in trades]).to_csv(buf, index=False)
    return buf.getvalue()
