import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built site lands in ../public, which server.js serves. During `vite`
// development, /api is forwarded to a locally running server.js.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
    target: "es2020",
    // Fixed names: an upload through GitHub's web UI overwrites the previous
    // build instead of adding new hashed files next to it. server.js serves
    // JS and CSS with `no-cache`, so browsers still pick up every change.
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  server: {
    proxy: { "/api": "http://localhost:8098" },
  },
});
