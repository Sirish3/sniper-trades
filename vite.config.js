import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The swing scanner's Flask API (swing_scanner/api.py), run
      // separately via `python api.py` on port 8003 — see
      // src/components/SwingScanner.jsx, EconomicCalendar.jsx, and
      // EarningsCalendar.jsx.
      '/swing-scanner-api': {
        target: 'http://127.0.0.1:8003',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/swing-scanner-api/, ''),
      },
    },
  },
})
