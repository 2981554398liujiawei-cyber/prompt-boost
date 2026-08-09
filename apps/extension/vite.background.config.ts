import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// background service worker：单入口 IIFE（MV3 经典脚本，不可代码分割）。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, "src/background/background.ts"),
      output: {
        format: "iife",
        entryFileNames: "background.js",
      },
    },
  },
});
