import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // changeOrigin stays false: the server's Origin check must see http://localhost:5173 (APP_ORIGIN in dev).
    proxy: {
      '/api': { target: 'http://localhost:3000' },
      '/ws': { target: 'http://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
  },
});
