import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
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
  test: {
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'e2e', 'public/legacy', 'docs/context-pack'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
