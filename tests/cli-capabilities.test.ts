import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCapabilities,
  warnForHostShell,
} from "../apps/cli/src/capabilities.js";

describe("CLI capability parsing", () => {
  it("accepts comma-separated capabilities from POSIX shells", () => {
    expect(parseCapabilities("fs.stat,fs.list,fs.read,docker.logs")).toEqual([
      "fs.stat",
      "fs.list",
      "fs.read",
      "docker.logs",
    ]);
  });

  it("accepts whitespace-separated capabilities forwarded by PowerShell", () => {
    expect(parseCapabilities("fs.stat fs.list fs.read docker.logs")).toEqual([
      "fs.stat",
      "fs.list",
      "fs.read",
      "docker.logs",
    ]);
  });

  it("deduplicates mixed separators without widening the capability allowlist", () => {
    expect(parseCapabilities("fs.read, fs.read\nfs.stat")).toEqual([
      "fs.read",
      "fs.stat",
    ]);
    expect(() => parseCapabilities("fs.read,process.exec;whoami")).toThrowError(
      expect.objectContaining({ code: "invalid_capabilities" }),
    );
    expect(() => parseCapabilities(" \n\t ")).toThrowError(
      expect.objectContaining({ code: "invalid_capabilities" }),
    );
  });

  it("accepts only the new host shell name and emits the explicit local risk warning", () => {
    expect(parseCapabilities("host.shell")).toEqual(["host.shell"]);
    expect(() => parseCapabilities("process.shell")).toThrowError(
      expect.objectContaining({ code: "invalid_capabilities" }),
    );

    const warnings: string[] = [];
    warnForHostShell(["fs.read"], (warning) => warnings.push(warning));
    expect(warnings).toEqual([]);
    warnForHostShell(["host.shell"], (warning) => warnings.push(warning));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("same operating-system user");
    expect(warnings[0]).toContain("Home by default");
    expect(warnings[0]).toContain("cwd does not narrow that authority");
    expect(warnings[0]).toContain("files, credentials, network, and services");
    expect(warnings[0]).toContain("no sandbox or isolation");
    expect(warnings[0]).toContain("persist after the Session ends");
  });

  it("describes filesystem commands against Home and the machine filesystem", () => {
    const cli = readFileSync(
      resolve(process.cwd(), "apps/cli/src/index.ts"),
      "utf8",
    );

    expect(cli).toContain('description("access a machine\'s Home and filesystem")');
    expect(cli).not.toContain("access a machine workspace");
  });
});
