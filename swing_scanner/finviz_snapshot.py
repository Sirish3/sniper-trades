"""Shared parser for Finviz's per-ticker quote-page snapshot table (Market
Cap, P/E, ROE, 52W High, etc.) — `finvizfinance`'s own `ticker_fundament()`
parser is broken against Finviz's current page (looks for a `quote_links`
container that no longer exists — confirmed live, see earnings_calendar.py's
module docstring), so this parses the table directly instead via
`finvizfinance.util.web_scrap`, same workaround already used there for
individual fields. This version reads every labeled value in one pass —
callers needing more than one or two fields from the same page should use
this instead of scanning the table repeatedly.
"""
from __future__ import annotations


def parse_snapshot_table(soup) -> dict[str, str]:
    """Returns {label: raw_text_value} for every row in the snapshot table
    (84 fields as of this writing — Market Cap, P/E, Forward P/E, PEG, P/S,
    P/B, P/FCF, EV/EBITDA, ROE, ROA, ROIC, margins, Debt/Eq, 52W High/Low,
    SMA20/50/200, etc.). Values are the raw displayed strings (e.g. "24.5",
    "1.82B", "12.40%") — callers parse units/percent signs themselves,
    since what's parseable varies by field (a market cap suffix isn't the
    same shape as a percent)."""
    values: dict[str, str] = {}
    for label_div in soup.find_all("div", class_="snapshot-td-label"):
        label = label_div.get_text(strip=True)
        parent_td = label_div.find_parent("td")
        val_td = parent_td.find_next_sibling("td") if parent_td else None
        if val_td is not None:
            values[label] = val_td.get_text(strip=True)
    return values
