import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: path.resolve(__dirname, '../dist/frontend'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom')) {
              return 'vendor-react';
            }
            if (id.includes('@xterm')) {
              return 'vendor-xterm';
            }
            if (id.includes('@monaco-editor')) {
              return 'vendor-monaco';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-lucide';
            }
            return 'vendor-others';
          }
        }
      }
    }
  },
  server: {
    port: 5174,
    proxy: {
      '/api/terminal': {
        target: 'http://localhost:8080',
        ws: true
      }
    }
  }
});
