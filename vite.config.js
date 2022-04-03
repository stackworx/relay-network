import path from "path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, "lib/main.js"),
      name: "relay-network",
      fileName: (format) => `relay-network".${format}.js`,
    },
    rollupOptions: {
      external: ["ky"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    // ...
  },
});
