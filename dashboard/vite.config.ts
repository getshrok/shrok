import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        // VAD AudioWorklet script (loaded via AudioWorklet.addModule)
        {
          src: path.resolve(__dirname, '../node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js'),
          dest: '',
        },
        // Default ONNX model (DEFAULT_MODEL = "legacy")
        {
          src: path.resolve(__dirname, '../node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx'),
          dest: '',
        },
        // v5 ONNX model (included for completeness)
        {
          src: path.resolve(__dirname, '../node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx'),
          dest: '',
        },
        // ONNX Runtime WASM binary (~12 MB) — fetched at runtime by ORT
        {
          src: path.resolve(__dirname, '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'),
          dest: '',
        },
        // ONNX Runtime WASM JS loader
        {
          src: path.resolve(__dirname, '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'),
          dest: '',
        },
      ],
    }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      // /api/voice listed FIRST (more specific) — per D-01 and Pitfall 4
      // ws: true enables WebSocket upgrade proxying for /api/voice/ws (Phase 19 endpoint)
      '/api/voice': {
        target: 'http://localhost:8888',
        changeOrigin: true,
        ws: true,
      },
      // Existing HTTP proxy for REST + SSE — unchanged per D-01
      '/api': {
        target: 'http://localhost:8888',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
