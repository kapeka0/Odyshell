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

  it("selects isolated named Client Profiles without combining identity paths", () => {
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");
    const up = readFileSync(resolve(cliRoot, "src/up.ts"), "utf8");

    expect(entry).toContain('.option("--profile <name>"');
    expect(entry).toContain("clientConfigPathForProfile(profileName)");
    expect(entry).toContain("client_profile_config_conflict");
    expect(up).toContain("client_profile_migration_conflict");
    expect(up).toContain("constants.COPYFILE_EXCL");
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

  it("separates typed Session requests from command-free Host Shell requests", () => {
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");
    const temporaryFlow = entry.slice(
      entry.indexOf("async function runInTemporarySession"),
      entry.indexOf("program\n  .command(\"login\")"),
    );
    const shellFlow = entry.slice(
      entry.indexOf('  .command("shell <machine>'),
      entry.indexOf("const fsCommand"),
    );

    expect(temporaryFlow).toContain("requestOperationSession");
    expect(temporaryFlow).toContain("requestHostShellSession");
    expect(temporaryFlow).toContain("session.host.shell");
    expect(temporaryFlow).toContain("session.execute");
    expect(temporaryFlow).toContain("await agent.complete(");
    expect(temporaryFlow).toContain("await agent.cancel(");
    expect(temporaryFlow).not.toContain("createSession(");
    expect(temporaryFlow).not.toContain("capability:");
    expect(temporaryFlow).not.toContain("process.shell");
    expect(shellFlow).toContain('.command("shell <machine> <command>")');
    expect(shellFlow).not.toContain('commandParts.join(" ")');
    expect(shellFlow).toContain(".requiredOption(");
    expect(shellFlow).toContain('"--purpose <purpose>"');
    expect(shellFlow).toContain('.option("--ttl <seconds>", "session lifetime", "3600")');
    expect(temporaryFlow).toContain("purpose: requestMetadata?.purpose");
  });

  it("exposes only canonical Agent Session commands", () => {
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");

    expect(entry).toContain('.command("sessions")');
    expect(entry).not.toContain('.command("session")');
    expect(entry).not.toContain('api.createOperation(');
    expect(entry).not.toContain('.session(sessionId)');
    expect(entry).not.toContain('.closeSession(sessionId)');
  });

  it("does not expose the superseded local MCP authorization path", () => {
    const entry = readFileSync(resolve(cliRoot, "src/index.ts"), "utf8");

    expect(entry).not.toContain('.command("mcp")');
    expect(existsSync(resolve(cliRoot, "src/mcp.ts"))).toBe(false);
    expect(packageJson.dependencies).not.toHaveProperty("@modelcontextprotocol/server");
    expect(packageJson.devDependencies).not.toHaveProperty("@odyshell/mcp");
  });
});
