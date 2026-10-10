import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// the API is proxied so the refresh-token cookie stays first-party in development
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: false },
    },
  },
})
