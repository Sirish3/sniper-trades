FROM python:3.11-slim

WORKDIR /app

COPY swing_scanner/requirements.txt ./swing_scanner/requirements.txt
COPY stock_screener/requirements.txt ./stock_screener/requirements.txt
COPY combined_service/requirements.txt ./combined_service/requirements.txt
RUN pip install --no-cache-dir \
    -r swing_scanner/requirements.txt \
    -r stock_screener/requirements.txt \
    -r combined_service/requirements.txt

COPY swing_scanner/ ./swing_scanner/
COPY stock_screener/ ./stock_screener/
COPY combined_service/ ./combined_service/

ENV PORT=8000
EXPOSE 8000

# --workers 1 is required, not just simple: this worker's boot spawns the
# scanner/screener sub-processes on fixed internal ports (8003/8004) — a
# second worker would double-spawn them and crash on a port conflict.
CMD ["gunicorn", "--workers", "1", "--timeout", "700", "--bind", "0.0.0.0:8000", "--chdir", "/app", "combined_service.proxy:app"]
