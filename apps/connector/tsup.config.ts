import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  noExternal: ["@odyshell/protocol"],
  banner: { js: "#!/usr/bin/env node" },
  removeNodeProtocol: false,
  sourcemap: true,
});
