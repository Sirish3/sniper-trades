FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8004
EXPOSE 8004

# --timeout is generous (not gunicorn's 30s default) because a cold,
# full-S&P-500 screen can take ~9-10 minutes (hundreds of individual
# Finnhub fundamentals requests, paced to respect the free-tier rate
# limit) — see README.md. --workers 1 keeps this simple; bump later if
# concurrent scans become a problem.
CMD ["gunicorn", "--workers", "1", "--timeout", "700", "--bind", "0.0.0.0:8004", "api:app"]
