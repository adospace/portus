// Bundles the three TypeScript entry points (Electron main, preload, renderer)
// with esbuild and copies the renderer HTML into dist/. Tailwind CSS is built
// separately by `npm run build:css`. Pass --watch to rebuild on change.
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
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
    // '.ttf' (file): Monaco ships a codicon font referenced from its CSS — emit it
    // next to app.css so the url() resolves on disk.
    loader: { '.json': 'json', '.ttf': 'file' },
    logLevel: 'info',
  },
  {
    // Monaco's generic editor web worker. Bundled as a standalone classic worker
    // script the renderer loads via `new Worker('./editor.worker.js')`. Only this
    // one worker is shipped (no per-language IntelliSense workers) — highlight-only.
    entryPoints: [resolve(root, 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js')],
    outfile: resolve(root, 'dist/renderer/editor.worker.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome128',
    sourcemap: true,
    logLevel: 'info',
  },
];

cpSync(resolve(root, 'renderer/index.html'), resolve(root, 'dist/renderer/index.html'));

// Ship the app icon into dist so the live window + favicon can load it (the
// packaging source stays build/icon.png; regenerate via `npm run icon`).
const iconSrc = resolve(root, 'build/icon.png');
if (existsSync(iconSrc)) cpSync(iconSrc, resolve(root, 'dist/renderer/icon.png'));
else console.warn('[build] build/icon.png missing — run `npm run icon`');

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => context(b)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[build] watching for changes…');
} else {
  await Promise.all(builds.map((b) => build(b)));
  console.log('[build] done');
}
