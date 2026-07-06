"""Streamlit UI: three tabs —

- Scanner: Run Scan button, filterable/sortable results table, a price
  chart (SMA50/150/200 + pivot/stop lines) for whichever row is selected,
  and a sidebar position-sizing calculator.
- Economic Calendar: this week + next week's US macro releases (Finviz
  live scrape merged with known_events.py's static schedule).
- Earnings: upcoming earnings dates for the current scan results or a
  session-only tracking list, flagging anything within 10 trading days.

Run with: streamlit run app.py
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from data import get_daily_bars, get_tradable_universe
from earnings_calendar import EARNINGS_RISK_TRADING_DAYS, get_earnings_for_tickers
from economic_calendar import (
    IMPACT_COLORS, filter_calendar, get_economic_calendar, next_high_impact_event,
)
from indicators import sma
from levels import TRAIL_RULE_TEXT, position_size
from pipeline import TEST_SUBSET, run_scan as _run_scan_pipeline

st.set_page_config(page_title="Swing Scanner", layout="wide")


@st.cache_data(show_spinner=False, ttl=3600)
def _cached_bars(symbol: str) -> pd.DataFrame | None:
    return get_daily_bars(symbol, lookback_days=400)


def run_scan(symbols: list[str], progress_bar=None, status_text=None) -> pd.DataFrame:
    def _progress(done: int, total: int, symbol: str) -> None:
        if status_text:
            status_text.text(f"Fetching {symbol} ({done}/{total})...")
        if progress_bar:
            progress_bar.progress(done / total)

    return _run_scan_pipeline(symbols, progress_callback=_progress)


def render_chart(symbol: str, row: pd.Series) -> None:
    df = _cached_bars(symbol)
    if df is None:
        st.warning(f"No cached data for {symbol}.")
        return

    plot_df = df.tail(260)
    fig = go.Figure()
    fig.add_trace(go.Candlestick(
        x=plot_df.index, open=plot_df["o"], high=plot_df["h"],
        low=plot_df["l"], close=plot_df["c"], name=symbol,
    ))
    fig.add_trace(go.Scatter(x=plot_df.index, y=sma(df["c"], 50).tail(260), name="SMA50", line=dict(width=1.3)))
    fig.add_trace(go.Scatter(x=plot_df.index, y=sma(df["c"], 150).tail(260), name="SMA150", line=dict(width=1.3)))
    fig.add_trace(go.Scatter(x=plot_df.index, y=sma(df["c"], 200).tail(260), name="SMA200", line=dict(width=1.3)))

    if pd.notna(row.get("Pivot / Entry")):
        fig.add_hline(y=row["Pivot / Entry"], line_dash="dash", line_color="green",
                       annotation_text=f"Entry {row['Pivot / Entry']:.2f}")
    if pd.notna(row.get("Initial Stop")):
        fig.add_hline(y=row["Initial Stop"], line_dash="dash", line_color="red",
                       annotation_text=f"Stop {row['Initial Stop']:.2f}")

    fig.update_layout(height=450, margin=dict(l=10, r=10, t=30, b=10), xaxis_rangeslider_visible=False)
    st.plotly_chart(fig, use_container_width=True)


def render_scanner_tab():
    with st.sidebar:
        st.header("Position Sizing")
        account_size = st.number_input("Account size ($)", min_value=0.0, value=25_000.0, step=1000.0)
        risk_pct = st.slider("Risk % per trade", min_value=0.1, max_value=5.0, value=1.0, step=0.1)
        entry_input = st.number_input("Entry price ($)", min_value=0.0, value=100.0, step=0.5)
        stop_input = st.number_input("Stop price ($)", min_value=0.0, value=92.0, step=0.5)

        sizing = position_size(account_size, risk_pct, entry_input, stop_input)
        st.metric("Dollar risk", f"${sizing['dollar_risk']:,.2f}")
        st.metric("Shares", f"{sizing['shares']:,}")
        st.metric("Position value", f"${sizing['position_value']:,.2f}")
        st.metric("% of account", f"{sizing['pct_of_account']:.1f}%")

        st.divider()
        st.header("Scan Universe")
        use_test_subset = st.checkbox(
            "Use 20-ticker test subset",
            value=True,
            help="Confirms the pipeline works end-to-end before running the full NYSE+NASDAQ universe, "
                 "which is much slower and hits Alpaca rate limits more.",
        )

    st.divider()

    run_clicked = st.button("Run Scan", type="primary")

    if run_clicked:
        if use_test_subset:
            symbols = TEST_SUBSET
        else:
            with st.spinner("Building tradable universe (cached daily)..."):
                symbols = get_tradable_universe()
            st.info(f"Scanning {len(symbols)} tickers in the full universe — this will take a while.")

        progress_bar = st.progress(0.0)
        status_text = st.empty()
        with st.spinner("Running scan..."):
            results = run_scan(symbols, progress_bar, status_text)
        progress_bar.empty()
        status_text.empty()

        st.session_state["scan_results"] = results

    results = st.session_state.get("scan_results")

    if results is None:
        st.info("Click **Run Scan** to screen the universe for Trend Template + VCP setups.")
        return

    if results.empty:
        st.warning("No tickers passed the Trend Template filter in this scan.")
        return

    st.subheader(f"Results ({len(results)} passed Trend Template)")

    col1, col2 = st.columns([2, 1])
    with col1:
        min_rs = st.slider("Minimum RS score", min_value=0, max_value=100, value=70)
    with col2:
        vcp_only = st.checkbox("Show only confirmed VCP setups", value=False)

    display_cols = [
        "Ticker", "Setup", "Current Price", "Pivot / Entry", "Initial Stop",
        "Risk/Share $", "Risk/Share %", "Target +20%", "RS Score",
        "% Off 52w High", "Vol vs 50d Avg", "Caution Tags",
    ]
    filtered = results[results["RS Score"] >= min_rs]
    if vcp_only:
        filtered = filtered[filtered["Setup"] == "VCP confirmed"]
    filtered = filtered.sort_values("RS Score", ascending=False).reset_index(drop=True)

    # st.dataframe renders missing values as the literal text "None"
    # regardless of column_config formatting — for the VCP-only columns
    # (blank whenever a row is "Trend OK, no VCP yet"), pre-format as
    # display strings with a dash placeholder instead of relying on NaN
    # rendering. "Current Price"/"RS Score"/etc. never have gaps (every
    # Trend Template pass has them), so those stay native NumberColumns.
    display = filtered.copy()
    for col in ["Pivot / Entry", "Initial Stop", "Risk/Share $", "Target +20%"]:
        display[col] = display[col].map(lambda v: f"${v:.2f}" if pd.notna(v) else "—")
    display["Risk/Share %"] = display["Risk/Share %"].map(lambda v: f"{v:.1f}%" if pd.notna(v) else "—")
    display["Caution Tags"] = display["Caution Tags"].map(lambda v: v if v else "—")

    column_config = {
        "Current Price": st.column_config.NumberColumn("Current Price", format="$%.2f"),
        "RS Score": st.column_config.NumberColumn("RS Score", format="%.0f"),
        "% Off 52w High": st.column_config.NumberColumn("% Off 52w High", format="%.1f%%"),
        "Vol vs 50d Avg": st.column_config.NumberColumn("Vol vs 50d Avg", format="%.2fx"),
    }

    selection = st.dataframe(
        display[display_cols],
        use_container_width=True,
        hide_index=True,
        on_select="rerun",
        selection_mode="single-row",
        column_config=column_config,
    )

    st.caption(f"Trail rule once in a position: {TRAIL_RULE_TEXT}")
    st.caption(
        "Caution Tags flag (not suppress) a new VCP breakout when a High-impact economic "
        "event is within 1 trading day, or earnings fall within the position's expected holding window."
    )

    selected_rows = selection.selection.rows if selection and selection.selection else []
    if selected_rows:
        selected_row = filtered.iloc[selected_rows[0]]
        st.subheader(f"{selected_row['Ticker']} chart")
        render_chart(selected_row["Ticker"], selected_row)
    else:
        st.caption("Select a row above to see its chart with SMA overlays and entry/stop lines.")


def render_economic_calendar_tab():
    st.subheader("Economic Calendar")
    st.caption(
        "Finviz's free calendar only exposes the current trading week — dates further out come from "
        "known_events.py's static schedule of confirmed BLS/Fed release dates instead."
    )

    refresh_clicked = st.button("Refresh", key="econ_refresh")
    events, live_ok = get_economic_calendar(force_refresh=refresh_clicked)

    if not live_ok:
        st.warning("Live data unavailable, showing scheduled events only.")

    nearest = next_high_impact_event(events)
    if nearest:
        event, days = nearest
        when = "today" if days == 0 else f"in {days} day{'s' if days != 1 else ''}"
        st.info(f"**Next high-impact event:** {event.event} {when} ({event.date})")
    else:
        st.info("No upcoming high-impact events found.")

    col1, col2, col3 = st.columns([1.5, 1, 1])
    with col1:
        impact_levels = st.multiselect("Impact", ["High", "Medium", "Low"], default=["High", "Medium"])
    today = date.today()
    monday_this_week = today - timedelta(days=today.weekday())
    default_start = monday_this_week
    default_end = monday_this_week + timedelta(days=13)
    with col2:
        start_date = st.date_input("From", value=default_start, key="econ_start")
    with col3:
        end_date = st.date_input("To", value=default_end, key="econ_end")

    filtered = filter_calendar(events, impact_levels=set(impact_levels) or None, start_date=start_date, end_date=end_date)

    if not filtered:
        st.info("No events match the current filters.")
        return

    df = pd.DataFrame([e.to_dict() for e in filtered])

    def _style_impact(val):
        color = IMPACT_COLORS.get(val)
        return f"color: {color}; font-weight: 600;" if color else ""

    styled = df.style.map(_style_impact, subset=["Impact"])
    st.dataframe(styled, use_container_width=True, hide_index=True)


def render_earnings_tab():
    st.subheader("Earnings")
    st.caption(
        f"Flags any ticker reporting within the next {EARNINGS_RISK_TRADING_DAYS} trading days — a stop-loss "
        "can't protect against a gap through it on an earnings surprise."
    )

    scan_results = st.session_state.get("scan_results")
    scan_tickers = scan_results["Ticker"].tolist() if scan_results is not None and not scan_results.empty else []

    if "earnings_tracking_list" not in st.session_state:
        st.session_state["earnings_tracking_list"] = ""

    with st.expander("Tracking list (tickers you currently hold, one per line)"):
        st.session_state["earnings_tracking_list"] = st.text_area(
            "Tickers",
            value=st.session_state["earnings_tracking_list"],
            label_visibility="collapsed",
            help="Session-only — not saved to disk. Re-enter after restarting the app.",
        )
    tracking_tickers = [
        t.strip().upper() for t in st.session_state["earnings_tracking_list"].splitlines() if t.strip()
    ]

    show_tracking_only = st.checkbox("Show only tickers I currently hold / am tracking", value=False)

    if show_tracking_only:
        tickers = tracking_tickers
        if not tickers:
            st.info("No tickers in your tracking list yet — add some above.")
            return
    else:
        tickers = scan_tickers
        if not tickers:
            st.info("No scan results yet — run a scan in the Scanner tab first, or add tickers to the tracking list above.")
            return

    with st.spinner(f"Fetching earnings data for {len(tickers)} ticker(s)..."):
        infos = get_earnings_for_tickers(tickers)

    rows = [info.to_dict() | {"_risk": info.earnings_risk, "_error": info.error} for info in infos]
    df = pd.DataFrame(rows)

    if any(r["_error"] for r in rows):
        failed = [info.ticker for info in infos if info.error]
        st.caption(f"Could not fetch data for: {', '.join(failed)}")

    display_cols = ["Ticker", "Next Earnings Date", "Days Until", "Before/After Market", "Est. EPS", "Prior Qtr EPS"]

    def _style_risk(row):
        return ["background-color: rgba(234, 179, 8, 0.25);" if row["_risk"] else ""] * len(row)

    styled = df.style.apply(_style_risk, axis=1)
    st.dataframe(styled, column_order=display_cols, use_container_width=True, hide_index=True)


def main():
    st.title("Swing Trading Scanner")
    st.caption("Trend Template (Stage 2) + simplified VCP detection, powered by Alpaca daily bars.")

    tab_scanner, tab_econ, tab_earnings = st.tabs(["Scanner", "Economic Calendar", "Earnings"])
    with tab_scanner:
        render_scanner_tab()
    with tab_econ:
        render_economic_calendar_tab()
    with tab_earnings:
        render_earnings_tab()


if __name__ == "__main__":
    main()
