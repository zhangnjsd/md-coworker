import { defineConfig } from 'vite'

// The bundle is referenced relatively from index.html (`./assets/...`), so the same build
// works at the server root and under a sub-path (`--base-path /cowork`). The client derives
// the mount point from the document URL at runtime; see src/util/path.js.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
    // Monaco (3.4MB) and Mermaid (2.7MB) are both lazily loaded on demand; if Vite injected
    // modulepreload for them, the browser would fetch them on first paint, defeating the point.
    modulePreload: false,
    // No manual chunking: a hand-written manualChunks easily forms "circular chunk references"
    // with the lazy-loading boundaries, and the browser then hits a TDZ
    // (Cannot access 'X' before initialization). Let Rollup do the splitting: monaco / mermaid
    // become separate chunks automatically because they use dynamic import.
  },
  server: {
    port: 5173,
    // `npm run dev` proxies the API/WS to the running Rust backend.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
})
