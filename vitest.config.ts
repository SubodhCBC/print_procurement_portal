import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Nest relies on `emitDecoratorMetadata`, which esbuild (Vitest's default
 * transformer) does not emit — DI would resolve to `undefined` at runtime.
 * SWC handles decorator metadata, so it transforms the sources instead.
 *
 * The `@/*` alias mirrors tsconfig.json#compilerOptions.paths.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**'],
      exclude: ['**/*.module.ts', 'src/main.ts', 'src/**/index.ts'],
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
