import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The standalone yfinance earnings microservice (earnings_service/),
      // run separately via `python earnings_service.py` on port 8001 — see
      // src/utils/earningsProvider.js.
      '/earnings-api': {
        // 127.0.0.1, not localhost — Flask only binds IPv4 (0.0.0.0), and
        // Node resolves "localhost" to the IPv6 loopback (::1) first,
        // which gets ECONNREFUSED since there's no IPv6 listener.
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/earnings-api/, ''),
      },
    },
  },
})
