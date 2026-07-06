"""Static fallback list of pre-scheduled high/medium-impact US macro
events. Finviz's free calendar (economic_calendar.py) only exposes the
*current* trading week — release schedules for CPI, PPI, FOMC, jobless
claims, PCE, GDP, etc. are published by BLS/BEA/the Fed months ahead, so
this list lets the combined calendar reach "this week + next week" (and
beyond) even before Finviz's own page would show those rows.

Update manually as new dates are published (BLS release schedule:
https://www.bls.gov/schedule/news_release/2026.htm, FOMC calendar:
https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm).
Dates below are illustrative — replace with the actual published
schedule for the periods you care about.
"""
from __future__ import annotations

KNOWN_HIGH_IMPACT_EVENTS = [
    {"date": "2026-07-14", "time": "08:30", "event": "CPI (June)", "impact": "High", "source": "BLS"},
    {"date": "2026-07-15", "time": "08:30", "event": "PPI (June)", "impact": "High", "source": "BLS"},
    {"date": "2026-07-16", "time": "08:30", "event": "Initial Jobless Claims", "impact": "Medium", "source": "DOL"},
    {"date": "2026-07-17", "time": "08:30", "event": "Import/Export Price Index (June)", "impact": "Medium", "source": "BLS"},
    {"date": "2026-07-16", "time": "08:30", "event": "Retail Sales (June)", "impact": "High", "source": "Census Bureau"},
    {"date": "2026-07-30", "time": "14:00", "event": "FOMC Rate Decision", "impact": "High", "source": "Federal Reserve"},
    {"date": "2026-07-30", "time": "14:30", "event": "FOMC Press Conference", "impact": "High", "source": "Federal Reserve"},
    {"date": "2026-07-31", "time": "08:30", "event": "GDP (Q2 Advance)", "impact": "High", "source": "BEA"},
    {"date": "2026-07-31", "time": "08:30", "event": "PCE Price Index (June)", "impact": "High", "source": "BEA"},
    {"date": "2026-08-01", "time": "08:30", "event": "Employment Situation (July jobs report)", "impact": "High", "source": "BLS"},
]
