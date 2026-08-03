import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: {
    access?: string;
    registry?: string;
  };
  exports?: unknown;
};

const releaseVersion = "0.10.1";
const manifests = [
  "apps/cli/package.json",
  "apps/client/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/mcp/package.json",
  "packages/protocol/package.json",
  "packages/sdk/package.json",
].map(readManifest);

describe("0.10.1 release contract", () => {
  it("exposes the built Server as the root production entrypoint", () => {
    const rootPackage = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(rootPackage.scripts?.start).toBe("node apps/server/dist/index.js");
  });

  it("uses one coordinated pre-1.0 version", () => {
    expect(manifests.map((manifest) => manifest.version)).toEqual(
      Array.from({ length: manifests.length }, () => releaseVersion),
    );
  });

  it("publishes only the intended packages", () => {
    const publicPackages = manifests.filter((manifest) => !manifest.private);
    expect(publicPackages.map((manifest) => manifest.name).sort()).toEqual([
      "@odyshell/cli",
      "@odyshell/protocol",
      "@odyshell/sdk",
    ]);
    for (const manifest of publicPackages) {
      expect(manifest.publishConfig).toEqual({
        access: "public",
        registry: "https://registry.npmjs.org/",
      });
    }
  });

  it("ships compiled SDK and protocol exports", () => {
    for (const name of ["@odyshell/protocol", "@odyshell/sdk"]) {
      const manifest = manifests.find((candidate) => candidate.name === name);
      expect(JSON.stringify(manifest?.exports)).toContain("./dist/index.js");
      expect(JSON.stringify(manifest?.exports)).toContain("./dist/index.d.ts");
      expect(JSON.stringify(manifest?.exports)).not.toContain("./src/");
    }
  });

  it("resolves the workspace protocol source before package build", () => {
    const webTypescript = readFileSync(
      resolve(process.cwd(), "apps/web/tsconfig.json"),
      "utf8",
    );
    expect(webTypescript).toContain(
      '"@odyshell/protocol": ["../../packages/protocol/src/index.ts"]',
    );
    const vitest = readFileSync(
      resolve(process.cwd(), "vitest.config.ts"),
      "utf8",
    );
    for (const workspacePackage of [
      "@odyshell/client",
      "@odyshell/protocol",
      "@odyshell/sdk",
    ]) {
      expect(vitest).toContain(`"${workspacePackage}"`);
    }
  });

  it("keeps CLI and MCP version labels aligned", () => {
    const cli = readFileSync(
      resolve(process.cwd(), "apps/cli/src/index.ts"),
      "utf8",
    );
    const mcp = readFileSync(
      resolve(process.cwd(), "apps/cli/src/mcp.ts"),
      "utf8",
    );
    const approvedMcp = readFileSync(
      resolve(process.cwd(), "packages/mcp/src/index.ts"),
      "utf8",
    );
    const client = readFileSync(
      resolve(process.cwd(), "apps/client/src/index.ts"),
      "utf8",
    );
    expect(cli).toContain(`.version("${releaseVersion}")`);
    expect(client).toContain(`CLIENT_VERSION = "${releaseVersion}"`);
    expect(
      `${mcp}\n${approvedMcp}`.match(
        new RegExp(`version: "${releaseVersion}"`, "g"),
      ),
    ).toHaveLength(2);
  });

  it("documents every supported package manager", () => {
    for (const path of [
      "README.md",
      "apps/cli/README.md",
      "packages/sdk/README.md",
      "docs/releases/0.10.1.md",
    ]) {
      const documentation = readFileSync(resolve(process.cwd(), path), "utf8");
      for (const manager of ["pnpm", "npm", "Yarn", "Bun"]) {
        expect(documentation).toContain(manager);
      }
    }
    expect(
      readFileSync(
        resolve(process.cwd(), "apps/web/content/docs/sdk.mdx"),
        "utf8",
      ),
    ).not.toContain("not published");
  });
});

function readManifest(path: string): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), path), "utf8"),
  ) as PackageManifest;
}
