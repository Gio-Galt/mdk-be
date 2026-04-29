import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Proxy API calls to the Fastify App Node during development
  server: {
    proxy: {
      '/mining': 'http://localhost:3000'
    }
  },
  build: {
    outDir: 'src/widget/dist'
  }
});
