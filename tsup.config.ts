import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  banner: undefined,
  external: [
    '@mariozechner/pi-ai',
    '@mariozechner/pi-ai/oauth',
    '@inquirer/prompts',
    'better-sqlite3',
    'ink',
    'ink-spinner',
    'react',
    'react/jsx-runtime',
  ],
});
