"""Fetches the current S&P 500 constituent list from Wikipedia."""

import sys

import pandas as pd

WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"


def get_sp500_tickers():
    """Return [{"symbol", "name", "sector"}, ...] for every S&P 500 company.

    Exits the program with an error message if Wikipedia can't be reached
    or the expected table columns aren't found.
    """
    try:
        table = pd.read_html(WIKI_URL)[0]
    except Exception as exc:
        print(f"❌ Failed to load S&P 500 ticker list from Wikipedia: {exc}")
        sys.exit(1)

    try:
        companies = []
        for _, row in table.iterrows():
            symbol = str(row["Symbol"]).strip().replace(".", "-")
            companies.append(
                {
                    "symbol": symbol,
                    "name": str(row["Security"]).strip(),
                    "sector": str(row["GICS Sector"]).strip(),
                }
            )
    except KeyError as exc:
        print(f"❌ Unexpected Wikipedia table format — missing column {exc}")
        sys.exit(1)

    if not companies:
        print("❌ No S&P 500 tickers found on Wikipedia page")
        sys.exit(1)

    print(f"✅ Loaded {len(companies)} S&P 500 tickers")
    return companies
