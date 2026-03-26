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
    '@anthropic-ai/sdk',
    'openai',
    '@google/genai',
    '@inquirer/prompts',
    'better-sqlite3',
    'ink',
    'ink-spinner',
  ],
});
