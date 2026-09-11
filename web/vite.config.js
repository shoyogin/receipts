import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// In dev, everything the API owns is proxied to the Python server on 8800.
// In production the same Python server hands out this app's built files, so
// these paths are same-origin either way and the app never needs a base URL.
const api = { target: 'http://127.0.0.1:8800', changeOrigin: false }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/img': api, '/download': api, '/file': api },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
