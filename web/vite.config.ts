import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // changeOrigin stays false: the server's Origin check must see http://localhost:5173 (APP_ORIGIN in dev).
    // 127.0.0.1, not localhost: localhost resolves to ::1 first, where another project's server on :3000 can answer.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000' },
      '/ws': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
  },
});
