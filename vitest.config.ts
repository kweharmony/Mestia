import { defineConfig } from "vitest/config";

// Отдельный конфиг для тестов: чистая логика, среда Node, без dev-сервера Tauri.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
