import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'index.ts',
    cli: 'cli.ts',
    config: 'src/config.ts',
  },
  format: ['esm'],
  target: 'node18',
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  outExtension: () => ({ js: '.js' }),
});
