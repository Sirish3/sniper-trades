"""Orchestrates the daily pattern-detection scan: pulls Alpaca bars for
each ticker (reusing data.py's existing get_daily_bars — no second Alpaca
pull), runs pattern_detector.py's rules via from_alpaca_json.py, upserts
chart_setups rows (new -> draft, existing+changed -> updated, existing+
unchanged -> skipped), and makes at most one batched Claude call per scan
run to draft descriptions for whatever's new/changed. Never auto-publishes
— see chart_setups.create_setup's default status="draft".
"""
from __future__ import annotations

import json
import logging
import os

import anthropic

from chart_setups import create_setup, get_setup_by_ticker_pattern, update_setup
from data import bars_df_to_candles, get_daily_bars
from from_alpaca_json import detect_patterns_from_json
from pipeline import TEST_SUBSET

logger = logging.getLogger(__name__)

MODEL = "claude-haiku-4-5-20251001"  # matches the model choice already used server-side by src/utils/claudeApi.js
CANDLE_LOOKBACK_DAYS = 300  # ~1 trading year — well past pattern_detector.py's MIN_BARS
LEVEL_TOLERANCE_PCT = 1.0   # a re-detected setup within this % of its stored levels counts as "unchanged"


def _levels_close(old: float | None, new: float | None, tolerance_pct: float = LEVEL_TOLERANCE_PCT) -> bool:
    if old is None and new is None:
        return True
    if old is None or new is None:
        return False
    if old == 0:
        return new == 0
    return abs(new - old) / abs(old) * 100 <= tolerance_pct


def _levels_unchanged(existing: dict, detected: dict) -> bool:
    return (
        _levels_close(existing.get("supportLow"), detected.get("supportLow"))
        and _levels_close(existing.get("supportHigh"), detected.get("supportHigh"))
        and _levels_close(existing.get("resistance"), detected.get("resistance"))
    )


def _template_description(row: dict) -> str:
    resistance = row.get("resistance")
    return (
        f"{row['ticker']} is showing a {row['patternType']} pattern with support near "
        f"{row.get('supportLow')}"
        + (f" and resistance near {resistance}." if resistance is not None else ".")
    )


def _build_batch_prompt(batch: list[dict]) -> str:
    items = [
        {
            "ticker": row["ticker"],
            "patternType": row["patternType"],
            "supportLow": row.get("supportLow"),
            "supportHigh": row.get("supportHigh"),
            "resistance": row.get("resistance"),
        }
        for row in batch
    ]
    return (
        "Write a short (2-3 sentence) technical-analysis blurb for each of these chart "
        "setups on a swing-trading site. Describe the pattern itself (what it looks like "
        "forming, why the levels matter) — do not predict a price target or give trade "
        "advice. Plain prose per item, no markdown.\n\n"
        f"Setups:\n{json.dumps(items)}\n\n"
        'Return ONLY a JSON array, no markdown, no preamble, in this exact shape: '
        '[{"ticker": "...", "patternType": "...", "description": "..."}]'
    )


def _extract_json_array(text: str) -> list:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("```")[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
    start, end = cleaned.find("["), cleaned.rfind("]")
    if start == -1 or end == -1:
        raise ValueError("No JSON array found in Claude's response")
    return json.loads(cleaned[start:end + 1])


def draft_batch_descriptions(batch: list[dict]) -> tuple[dict[tuple[str, str], str], bool]:
    """One Claude call covering the whole batch. Returns
    ({(ticker, patternType): description}, call_was_attempted) — the bool
    lets the caller report an accurate Claude-call count even when the
    call itself fails (attempted-but-failed still counts as a call made,
    same as any other API call)."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key or not batch:
        return {}, False

    client = anthropic.Anthropic(api_key=api_key)
    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=200 * len(batch) + 200,
            messages=[{"role": "user", "content": _build_batch_prompt(batch)}],
        )
        parsed = _extract_json_array(response.content[0].text)
    except Exception:
        logger.exception("Batched Claude writeup call failed — falling back to templated descriptions")
        return {}, True

    descriptions: dict[tuple[str, str], str] = {}
    for item in parsed:
        try:
            descriptions[(item["ticker"].upper(), item["patternType"])] = item["description"]
        except (KeyError, AttributeError, TypeError):
            continue  # malformed entry — that one setup falls back to the template, not the whole batch
    return descriptions, True


def run_pattern_scan(symbols: list[str] | None = None) -> dict:
    """symbols defaults to pipeline.TEST_SUBSET (20 large caps) rather than
    the full tradable universe — a full-universe daily scan is a real
    cost/latency decision (thousands of Alpaca fetches + pattern checks on
    a free-tier Render instance) worth confirming deliberately; swap in
    get_tradable_universe() once that's been decided.
    """
    symbols = symbols or TEST_SUBSET

    detected_per_ticker: dict[str, int] = {}
    skipped = 0
    batch: list[dict] = []  # newly-created or meaningfully-changed rows, pending a description

    for symbol in symbols:
        df = get_daily_bars(symbol, lookback_days=CANDLE_LOOKBACK_DAYS)
        if df is None:
            detected_per_ticker[symbol] = 0
            continue

        candles = bars_df_to_candles(df)
        setups = detect_patterns_from_json(candles, symbol)
        detected_per_ticker[symbol] = len(setups)

        for setup in setups:
            setup = {k: v for k, v in setup.items() if k != "confidence"}  # informational only, not a DB column
            existing = get_setup_by_ticker_pattern(setup["ticker"], setup["patternType"])

            if existing and _levels_unchanged(existing, setup):
                skipped += 1
                continue

            if existing:
                row = update_setup(existing["id"], {
                    "supportLow": setup["supportLow"],
                    "supportHigh": setup["supportHigh"],
                    "resistance": setup["resistance"],
                    "chartAnnotations": setup["chartAnnotations"],
                })
            else:
                row = create_setup({**setup, "status": "draft"})

            batch.append(row)

    claude_call_made = False
    if batch:
        descriptions, claude_call_made = draft_batch_descriptions(batch)
        for i, row in enumerate(batch):
            description = descriptions.get((row["ticker"], row["patternType"])) or _template_description(row)
            batch[i] = update_setup(row["id"], {"description": description})

    return {
        "detectedPerTicker": detected_per_ticker,
        "skipped": skipped,
        "claudeCalls": 1 if claude_call_made else 0,
        "rows": batch,
    }
