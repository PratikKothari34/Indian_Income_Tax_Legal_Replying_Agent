import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  // Packaged build loads from file:// — relative asset paths are required.
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  server: {
    host: "127.0.0.1",
    // 5174, not 5173 — v1 and v2 must be able to run side by side.
    port: 5174,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // No remote sourcemap fetches, no CDN; everything resolves locally.
    sourcemap: false,
    target: "chrome120"
  }
});
