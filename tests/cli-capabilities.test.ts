import { describe, expect, it } from "vitest";
import { parseCapabilities } from "../apps/cli/src/capabilities.js";

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
});
