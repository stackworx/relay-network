import {defineConfig} from "tsdown";

export default defineConfig({
  exports: true,
  sourcemap: true,
  minify: false,
  entry: "src/main.ts",
  external: ["ky", "extract-files/extractFiles.mjs"],
});
