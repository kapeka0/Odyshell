import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cliRoot = resolve(process.cwd(), "apps/cli");
const packageJson = JSON.parse(
  readFileSync(resolve(cliRoot, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
  license: string;
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
    expect(packageJson.license).toBe("Apache-2.0");
    expect(existsSync(resolve(cliRoot, "LICENSE"))).toBe(true);
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.bin).toEqual({ ods: "dist/index.js" });
    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.scripts.prepack).toBe("pnpm build");
    expect(packageJson.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
    });
  });

  it("bundles private workspace code instead of publishing workspace dependencies", () => {
    for (const dependency of ["@odyshell/client", "@odyshell/protocol"]) {
      expect(packageJson.dependencies).not.toHaveProperty(dependency);
      expect(packageJson.devDependencies[dependency]).toBe("workspace:*");
    }
    expect(packageJson.devDependencies).not.toHaveProperty("@odyshell/sdk");

    const tsup = readFileSync(resolve(cliRoot, "tsup.config.ts"), "utf8");
    expect(tsup).toContain('"@odyshell/client"');
    expect(tsup).toContain('"@odyshell/protocol"');
    expect(tsup).not.toContain('"@odyshell/sdk"');
  });

  it("keeps the binary version aligned with the package version", () => {
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");
    expect(entry).toContain(`.version("${packageJson.version}")`);
  });

  it("selects isolated named Client Profiles without combining identity paths", () => {
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");
    const up = readFileSync(resolve(cliRoot, "src/up.ts"), "utf8");

    expect(entry).toContain('.option("--profile <name>"');
    expect(entry).toContain("clientConfigPathForProfile(profileName)");
    expect(entry).toContain("client_profile_config_conflict");
    expect(up).not.toContain("legacyConfigPath");
    expect(up).not.toContain("COPYFILE_EXCL");
    expect(up).not.toContain("instanceConfigPath");
  });

  it("provides a dedicated local Profile management command", () => {
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");

    expect(entry).toContain('.command("profiles")');
    expect(entry).toContain('.command("ls")');
    expect(entry).toContain('.command("status <name>")');
    expect(entry).toContain('.command("remove <name>")');
    expect(entry).not.toContain('.command("remove")\n  .description("stop and delete one local Client Profile")');
  });

  it("supports Human OAuth and control-plane operations without local MCP", () => {
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");
    for (const command of ["login", "logout", "machines", "agents", "sessions", "commands"]) {
      expect(entry).toContain(`.command("${command}`);
    }
    for (const command of ["token", "audit", "exec", "shell", "fs", "docker", "mcp"]) {
      expect(entry).not.toContain(`.command("${command}`);
    }
    expect(entry).not.toContain("@odyshell/sdk");
    expect(packageJson.dependencies).not.toHaveProperty("open");
  });

  it("does not expose the superseded local MCP authorization path", () => {
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");

    expect(entry).not.toContain('.command("mcp")');
    expect(existsSync(resolve(cliRoot, "src/mcp.ts"))).toBe(false);
    expect(packageJson.dependencies).not.toHaveProperty("@modelcontextprotocol/server");
    expect(packageJson.devDependencies).not.toHaveProperty("@odyshell/mcp");
  });

  it("publishes the Machine installer for Linux, macOS, and Windows", () => {
    expect((packageJson as typeof packageJson & { os?: string[] }).os).toBeUndefined();
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");
    expect(entry).toContain("assertSupportedClientHost();");
  });
});
