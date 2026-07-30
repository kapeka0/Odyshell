import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  noExternal: ["@odyshell/protocol"],
  banner: { js: "#!/usr/bin/env node" },
  removeNodeProtocol: false,
  sourcemap: true,
  dts: true,
  clean: true,
});
