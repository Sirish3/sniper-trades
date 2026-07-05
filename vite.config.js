import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The swing scanner's Flask API (swing_scanner/api.py), run
      // separately via `python api.py` on port 8003 — see
      // src/components/SwingScanner.jsx.
      '/swing-scanner-api': {
        target: 'http://127.0.0.1:8003',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/swing-scanner-api/, ''),
      },
      // The stock screener's Flask API (stock_screener/api.py), run
      // separately via `python api.py` on port 8004 — see
      // src/components/StockScreener.jsx.
      '/stock-screener-api': {
        target: 'http://127.0.0.1:8004',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/stock-screener-api/, ''),
      },
    },
  },
})
