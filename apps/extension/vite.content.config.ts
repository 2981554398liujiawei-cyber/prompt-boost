import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// content script：单入口 IIFE，内联全部依赖（MV3 经典脚本，不可代码分割）。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, "src/content/content.ts"),
      output: {
        format: "iife",
        entryFileNames: "content.js",
      },
    },
  },
});
