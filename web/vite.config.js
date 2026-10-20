import { defineConfig } from 'vite';

const target = process.env.API_URL || 'http://localhost:3000';

export default defineConfig({
  server: {
    host: true,
    proxy: {
      '/api': target,
      '/socket.io': { target, ws: true },
    },
  },
});
