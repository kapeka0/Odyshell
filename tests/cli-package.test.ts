import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cliRoot = resolve(process.cwd(), "apps/cli");
const packageJson = JSON.parse(
  readFileSync(resolve(cliRoot, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
  private?: boolean;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  publishConfig?: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("CLI npm package", () => {
  it("publishes the ods binary to the public npm registry", () => {
    expect(packageJson.name).toBe("@odyshell/cli");
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.bin).toEqual({ ods: "./dist/index.js" });
    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.scripts.prepack).toBe("pnpm build");
    expect(packageJson.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
    });
  });

  it("bundles private workspace code instead of publishing workspace dependencies", () => {
    for (const dependency of [
      "@odyshell/client",
      "@odyshell/protocol",
      "@odyshell/sdk",
    ]) {
      expect(packageJson.dependencies).not.toHaveProperty(dependency);
      expect(packageJson.devDependencies[dependency]).toBe("workspace:*");
    }

    const tsup = readFileSync(resolve(cliRoot, "tsup.config.ts"), "utf8");
    expect(tsup).toContain('"@odyshell/client"');
    expect(tsup).toContain('"@odyshell/protocol"');
    expect(tsup).toContain('"@odyshell/sdk"');
  });

  it("keeps the binary version aligned with the package version", () => {
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");
    expect(entry).toContain(`.version("${packageJson.version}")`);
  });
});
