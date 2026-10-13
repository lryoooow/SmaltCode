/** Bundle the CLI (and the inlined kernel) into one self-contained CJS file. */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist-bundle/main.cjs',
  sourcemap: false,
  minify: false, // keep it debuggable; size is fine for a CLI
  logLevel: 'info',
});
