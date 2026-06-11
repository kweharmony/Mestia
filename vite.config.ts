import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri ожидает фиксированный порт и не падает при его занятости.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Vite-опции, заточенные под Tauri.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Жёстко привязываемся к IPv4 (localhost на Windows может резолвиться в ::1,
    // из-за чего Tauri не достучится до dev-сервера и зависает на «Waiting…»).
    host: host || "127.0.0.1",
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Не следим за Rust-исходниками — это делает сам Tauri.
      ignored: ["**/src-tauri/**"],
    },
  },

  // Делаем сборку совместимой с целевыми платформами Tauri.
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
