import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function workspaceSource(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      "@odyshell/client": workspaceSource("./apps/client/src/index.ts"),
      "@odyshell/mcp": workspaceSource("./packages/mcp/src/index.ts"),
      "@odyshell/protocol": workspaceSource("./packages/protocol/src/index.ts"),
    },
  },
});
