FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8003
EXPOSE 8003

# --timeout is generous (not gunicorn's 30s default) because a cold,
# full-universe scan can take minutes (hundreds of Alpaca bar fetches) —
# see README.md. --workers 1 keeps this simple; this service has no shared
# in-process state that would break under >1 worker (unlike backend/'s
# scheduler), so bump workers later if concurrent scans become a problem.
CMD ["gunicorn", "--workers", "1", "--timeout", "600", "--bind", "0.0.0.0:8003", "api:app"]
