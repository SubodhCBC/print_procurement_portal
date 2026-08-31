import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** End-to-end suite. Requires the local stack: `pnpm infra:up`. */
export default defineConfig({
  root: path.resolve(__dirname, '..'),
  resolve: {
    alias: { '@': path.resolve(__dirname, '..', 'src') },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e-spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The suites share one database and one Redis; running them concurrently
    // would make them race each other.
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
