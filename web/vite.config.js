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
    // Monaco（3.4MB）与 Mermaid（2.7MB）都是按需动态加载的，如果让 Vite 给它们注入
    // modulepreload，浏览器会在首屏就把它们拉下来，等于白做懒加载。
    modulePreload: false,
    // 不手动分 chunk：手写 manualChunks 很容易和懒加载边界形成"循环 chunk 引用"，
    // 浏览器执行到时会撞上 TDZ（Cannot access 'X' before initialization）。
    // 交给 Rollup 自己拆——monaco / mermaid 因为用动态 import 会自动独立成 chunk。
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
