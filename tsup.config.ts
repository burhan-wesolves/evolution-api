import { cpSync } from 'node:fs';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src'],
  outDir: 'dist',
  splitting: false,
  // Runtime is CJS (`node dist/main` via package.json `type: commonjs`).
  // ESM output was unused and doubled build time + memory. Sourcemap and
  // minify add cost with no runtime benefit — Node doesn't care.
  sourcemap: false,
  clean: true,
  minify: false,
  format: ['cjs'],
  onSuccess: async () => {
    cpSync('src/utils/translations', 'dist/translations', { recursive: true });
  },
  loader: {
    '.json': 'file',
    '.yml': 'file',
  },
});
