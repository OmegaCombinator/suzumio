import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [preact()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:39400", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:39400", changeOrigin: true },
    },
  },
  build: {
    outDir: "../dist/webui",
    emptyOutDir: true,
  },
});
