import { defineConfig } from 'vite';

// Relative base so the built app can be served from any path
// (dev server, static hosting, or packed into an .ehpk).
export default defineConfig({
  base: './',
  server: { port: 5173 },
});
