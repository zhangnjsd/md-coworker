import { defineConfig } from 'vite'

// The Rust backend (axum) serves `web/dist` at the server root and falls back to
// index.html, so the bundle must be built with base '/'.
export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('monaco-editor')) return 'monaco'
          if (id.includes('mermaid') || id.includes('cytoscape') || id.includes('dagre')) return 'mermaid'
          if (id.includes('@codemirror') || id.includes('@lezer')) return 'codemirror'
          if (id.includes('katex')) return 'katex'
          return 'vendor'
        },
      },
    },
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
