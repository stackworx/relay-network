import path from "path";
import {defineConfig} from "vite";

export default defineConfig({
  build: {
    // Leave minification up to bunlder
    minify: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, "src/main.ts"),
      name: "relay-network",
      fileName: (format) => `relay-network.${format}.js`,
      formats: ["es"],
    },
    rollupOptions: {
      external: ["ky", "extract-files/extractFiles.mjs"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    // ...
  },
});
