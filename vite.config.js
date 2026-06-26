import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Alpaca market data (historical bars) lives on a separate host.
      // Must be listed before '/alpaca' below — otherwise that broader
      // prefix matches '/alpaca-data' requests first and routes them to
      // the wrong host.
      '/alpaca-data': {
        target: 'https://data.alpaca.markets',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/alpaca-data/, ''),
      },
      // Alpaca's API doesn't send CORS headers, so proxy paper-trading
      // requests through the dev server to avoid browser CORS errors.
      '/alpaca': {
        target: 'https://paper-api.alpaca.markets',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/alpaca/, ''),
      },
      // Finnhub doesn't send CORS headers either.
      '/finnhub': {
        target: 'https://finnhub.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/finnhub/, ''),
      },
      // Yahoo Finance (unofficial) for short interest — needs the crumb/cookie
      // dance, so rewrite the cookie domain to localhost to make it stick.
      '/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        cookieDomainRewrite: 'localhost',
        rewrite: (path) => path.replace(/^\/yahoo/, ''),
      },
      // Wikipedia's MediaWiki API for live S&P 500 / Nasdaq-100 constituent
      // refreshes (Finnhub's and FMP's index-constituents endpoints both
      // require a paid plan — confirmed against this project's free-tier
      // keys, so Wikipedia's public constituents tables are the free option).
      '/wikipedia': {
        target: 'https://en.wikipedia.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wikipedia/, ''),
      },
      // The standalone Python execution-scheduler backend (backend/),
      // run separately via `python app.py` on port 8000. Proxied so the
      // Screener's "Email Alert" button avoids a cross-origin request.
      '/scheduler-api': {
        // 127.0.0.1, not localhost — Flask only binds IPv4 (0.0.0.0), and
        // Node resolves "localhost" to the IPv6 loopback (::1) first,
        // which gets ECONNREFUSED since there's no IPv6 listener.
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/scheduler-api/, ''),
      },
      // The standalone yfinance earnings microservice (earnings_service/),
      // run separately via `python earnings_service.py` on port 8001 — see
      // src/utils/earningsProvider.js. Same IPv4-vs-IPv6 note as
      // '/scheduler-api' above.
      '/earnings-api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/earnings-api/, ''),
      },
    },
  },
})
