import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const projectRoot = import.meta.dirname;

export default defineConfig({
  // One root index.html with the Vite root at the project root (§3).
  root: projectRoot,
  plugins: [react(), tailwindcss()],
  build: {
    // Built assets are served by the dashboard server from this directory only.
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    // §5: an explicitly selected host (private address, 0.0.0.0, or a VPN/NAT
    // hostname) must work without a second flag or an allowlist. That requires
    // disabling Vite's development Host header check for this project.
    allowedHosts: true,
  },
});
