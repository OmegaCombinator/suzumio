import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [preact()],
  build: {
    outDir: "../dist/webui",
    emptyOutDir: true,
  },
});
