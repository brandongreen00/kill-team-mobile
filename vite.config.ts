import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// GitHub Pages serves this repo at https://<user>.github.io/kill-team-mobile/
export default defineConfig({
  base: '/kill-team-mobile/',
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@teams': resolve(__dirname, 'src/teams'),
      '@ui': resolve(__dirname, 'src/ui'),
      '@ai': resolve(__dirname, 'src/ai'),
      '@data': resolve(__dirname, 'data'),
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: { host: true, port: 5173 },
});
