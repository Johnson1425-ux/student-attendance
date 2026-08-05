import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // During local development the dashboard talks to the API through this
    // proxy, so the browser sees a single origin and CORS never comes into it.
    proxy: {
      '/api': { target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Charts are a large dependency used on two screens; splitting it keeps
        // the initial dashboard payload small on a school's connection.
        manualChunks: { charts: ['recharts'], vendor: ['react', 'react-dom', 'react-router-dom'] },
      },
    },
  },
});
