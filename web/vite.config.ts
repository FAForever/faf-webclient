import { createHash } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * `?v=<content hash>` on the script and stylesheet links in index.html. The
 * file names stay fixed (see below), but a browser or a data-saving proxy
 * that kept an old copy against `no-cache` cannot pair it with a new page:
 * every build that changes them is a new address.
 */
function versionedAssets(): Plugin {
  return {
    name: "versioned-assets",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle ?? {};
        return html.replace(/(src|href)="(\/assets\/[^"?]+\.(?:js|css))"/g, (match, attr: string, path: string) => {
          const item = bundle[path.slice(1)];
          if (!item) return match;
          const body = item.type === "chunk" ? item.code : item.source;
          const version = createHash("sha256").update(body).digest("hex").slice(0, 10);
          return `${attr}="${path}?v=${version}"`;
        });
      },
    },
  };
}

// The built site lands in ../public, which server.js serves. During `vite`
// development, /api is forwarded to a locally running server.js.
export default defineConfig({
  plugins: [react(), versionedAssets()],
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
