// Bundles the Edge Script into one file, dist/index.js, for upload to Bunny.
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

/** `import text from './file?raw'`: the file's content as a string (as in Vite, which the tests use). */
const raw = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, a => ({ path: new URL(a.path.slice(0, -4), `file://${a.resolveDir}/`).pathname, namespace: 'raw' }))
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async a => ({ contents: await readFile(a.path, 'utf8'), loader: 'text' }))
  },
}

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2023',
  conditions: ['deno', 'worker', 'browser'],
  mainFields: ['module', 'main'],
  minify: false,
  legalComments: 'none',
  plugins: [raw],
  logLevel: 'info',
})
