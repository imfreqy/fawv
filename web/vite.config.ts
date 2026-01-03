import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path"; // ESM-safe import

export default defineConfig(({ mode }) => {
  const isDemo = mode === 'demo'

  return {
    plugins: [react()],
    base: isDemo ? '/demo/' : '/',
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,          // <- force 5173
    strictPort: true,    // <- fail fast if taken (so you notice)
    proxy: {
      "/api": {
        target: "http://localhost:4000", // <- your API
        changeOrigin: true,
        secure: false,
      },
    },
  },
  };
});
