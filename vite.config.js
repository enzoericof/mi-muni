import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // En desarrollo, proxea /api/* al servidor Express (puerto 8787).
    // En producción Railway, Express sirve el dist/ directamente → mismo origen, sin proxy.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
