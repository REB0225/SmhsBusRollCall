import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0', // Listen on all network interfaces
    port: 5174,
    strictPort: true,
    allowedHosts: true // For Vite 6+ to allow zrok/public domains
  }
});
