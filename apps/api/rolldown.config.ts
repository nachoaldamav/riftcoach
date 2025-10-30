import { defineConfig } from "rolldown";

export default defineConfig([
  {
    input: "src/index.ts",
    platform: "node",
    // Externalize native bindings and their loader to avoid bundling .node files
    external: [/^@resvg\/resvg-js(.*)?$/, /\.node$/],
    output: {
      format: "esm",
      dir: "dist",
      sourcemap: true,
    },
  },
]);
