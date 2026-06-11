// Ambient type for the bridge exposed by electron/preload.ts. Imported as a
// type only, so nothing from the Electron side is bundled into the renderer.
import type { PortusApi } from '../electron/preload';

declare global {
  interface Window {
    api: PortusApi;
  }
}

// The bundled Lucide collection — typed loosely so TS doesn't parse the ~1.5MB
// JSON for structure (esbuild handles the actual import at build time).
declare module '@iconify-json/lucide/icons.json' {
  const data: import('@iconify/iconify').IconifyJSON;
  export default data;
}

export {};
