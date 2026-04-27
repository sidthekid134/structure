import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: {
    outDir: path.resolve(__dirname, '../src/studio/static'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/three/') || id.includes('@react-three/')) return 'three';
          if (id.includes('/recharts/') || id.includes('/d3-')) return 'charts';
          if (id.includes('/framer-motion/')) return 'motion';
          if (id.includes('/radix-ui/') || id.includes('@radix-ui/')) return 'radix';
          if (id.includes('/@dnd-kit/')) return 'dnd';
          if (id.includes('/lucide-react/')) return 'icons';
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/scheduler/')
          ) {
            return 'react';
          }
          return 'vendor';
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
