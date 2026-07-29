import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  noExternal: [
    "@odyshell/client",
    "@odyshell/protocol",
    "zod",
  ],
  external: ["node:sqlite"],
  banner: { js: "#!/usr/bin/env node" },
  removeNodeProtocol: false,
  sourcemap: true,
  clean: true,
});
