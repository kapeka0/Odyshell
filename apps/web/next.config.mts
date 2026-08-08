import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
  async rewrites() {
    return [
      {
        source: "/docs.md",
        destination: "/llms.mdx/docs",
      },
      {
        source: "/docs/:path*.md",
        destination: "/llms.mdx/docs/:path*",
      },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
