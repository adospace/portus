// Bundles the three TypeScript entry points (Electron main, preload, renderer)
// with esbuild and copies the renderer HTML into dist/. Tailwind CSS is built
// separately by `npm run build:css`. Pass --watch to rebuild on change.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

mkdirSync(resolve(root, 'dist/renderer'), { recursive: true });
mkdirSync(resolve(root, 'dist/electron'), { recursive: true });

/** Shared options for the Node-side bundles (main + preload). */
const nodeCommon = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  // Electron and the native node-pty addon must be required at runtime, not bundled.
  external: ['electron', 'node-pty'],
  logLevel: 'info',
};

const builds = [
  {
    ...nodeCommon,
    entryPoints: [resolve(root, 'electron/main.ts')],
    outfile: resolve(root, 'dist/electron/main.js'),
  },
  {
    ...nodeCommon,
    entryPoints: [resolve(root, 'electron/preload.ts')],
    outfile: resolve(root, 'dist/electron/preload.js'),
  },
  {
    entryPoints: [resolve(root, 'renderer/app.ts')],
    outfile: resolve(root, 'dist/renderer/app.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome128',
    sourcemap: true,
    loader: { '.json': 'json' },
    logLevel: 'info',
  },
];

cpSync(resolve(root, 'renderer/index.html'), resolve(root, 'dist/renderer/index.html'));

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[build] watching for changes…');
} else {
  await Promise.all(builds.map((b) => build(b)));
  console.log('[build] done');
}
