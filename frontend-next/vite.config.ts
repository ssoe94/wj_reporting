import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  base: "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": srcPath,
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4174,
  },
});
