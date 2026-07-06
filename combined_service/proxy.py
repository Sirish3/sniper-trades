"""Reverse-proxy Flask app for the one Render web service slot available
beyond the paid scheduler. Render only gave us one free service, but the
site needs two Python backends (swing_scanner's Trend Template/VCP scan,
stock_screener's Finviz-style S&P500/Nasdaq100/custom screen) — so this
runs both as their own subprocesses on internal ports and forwards
/scanner/* and /screener/* to them by path prefix.

Each sub-app keeps its own untouched `from data import ...` style bare
imports (both have a data.py, an api.py, etc.) — importing them into one
process would collide on those module names in sys.modules. Running each
as its own `python api.py` subprocess, with its own directory as CWD,
keeps them genuinely isolated instead.

Run locally with: python proxy.py  (spawns both siblings itself)
In prod (Docker): gunicorn combined_service.proxy:app (see Dockerfile;
--workers 1 is required — a second worker would double-spawn the
siblings and crash on a port conflict).
"""
from __future__ import annotations

import os
import subprocess
import sys
import time

import requests
from flask import Flask, Response, request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCANNER_PORT = 8003
SCREENER_PORT = 8004

ALLOWED_ORIGINS = {"https://stockpilot.cc", "http://localhost:5173", "http://localhost:5174"}

# Headers we must not blindly relay from the upstream sub-app's response:
# the CORS ones so the proxy's own (fresh) values aren't duplicated (a
# browser rejects a response with two Access-Control-Allow-Origin values),
# and the framing ones because `requests` already unpacked the body into
# `.content` — repeating the upstream's Content-Length/Transfer-Encoding
# would describe bytes that no longer match what Flask sends here.
STRIPPED_RESPONSE_HEADERS = {
    "content-encoding", "content-length", "transfer-encoding", "connection",
    "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers",
    "server", "date",  # Werkzeug adds its own fresh copies of these
}

_subprocesses: list[subprocess.Popen] = []


def _spawn(cwd: str, port: int) -> subprocess.Popen:
    env = {**os.environ, "PORT": str(port)}
    proc = subprocess.Popen([sys.executable, "api.py"], cwd=cwd, env=env)
    _subprocesses.append(proc)
    return proc


def _wait_until_up(port: int, timeout: float = 60) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            requests.get(f"http://127.0.0.1:{port}/health", timeout=2)
            return
        except requests.RequestException:
            time.sleep(0.5)
    raise RuntimeError(f"Sub-service on port {port} did not come up within {timeout}s")


_spawn(os.path.join(ROOT, "swing_scanner"), SCANNER_PORT)
_spawn(os.path.join(ROOT, "stock_screener"), SCREENER_PORT)
_wait_until_up(SCANNER_PORT)
_wait_until_up(SCREENER_PORT)

app = Flask(__name__)


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin")
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.route("/health")
def health():
    return {"status": "ok"}


def _forward(target_port: int, path: str):
    url = f"http://127.0.0.1:{target_port}/{path}"
    upstream = requests.request(
        request.method,
        url,
        params=request.args,
        headers={k: v for k, v in request.headers if k.lower() != "host"},
        data=request.get_data(),
        timeout=700,
    )
    headers = [(k, v) for k, v in upstream.raw.headers.items() if k.lower() not in STRIPPED_RESPONSE_HEADERS]
    return Response(upstream.content, status=upstream.status_code, headers=headers)


@app.route("/scanner/<path:path>", methods=["GET", "POST", "OPTIONS"])
def scanner_proxy(path):
    return _forward(SCANNER_PORT, path)


@app.route("/screener/<path:path>", methods=["GET", "POST", "OPTIONS"])
def screener_proxy(path):
    return _forward(SCREENER_PORT, path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
