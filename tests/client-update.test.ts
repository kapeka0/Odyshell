import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  compatibleClientUpdate,
  packageManagerForPath,
  updateClientPackage,
  verifyPackageIntegrity,
  type UpdateDependencies,
} from "../apps/cli/src/update.js";

describe("Client updates", () => {
  it("allows only patch updates within one pre-1.0 minor line", () => {
    expect(compatibleClientUpdate("0.9.0", "0.9.4")).toBe(true);
    expect(compatibleClientUpdate("0.9.0", "0.10.0")).toBe(false);
    expect(compatibleClientUpdate("0.9.0", "1.0.0")).toBe(false);
  });

  it("uses constant-time SHA-512 package verification", () => {
    const artifact = Buffer.from("verified package");
    const integrity = `sha512-${createHash("sha512")
      .update(artifact)
      .digest("base64")}`;
    expect(verifyPackageIntegrity(artifact, integrity)).toBe(true);
    expect(verifyPackageIntegrity(Buffer.from("tampered"), integrity)).toBe(
      false,
    );
    expect(verifyPackageIntegrity(artifact, "sha1-unsafe")).toBe(false);
  });

  it("updates through the package manager that owns the current CLI", () => {
    expect(
      packageManagerForPath(
        "/home/ada/.local/share/pnpm/global/5/node_modules/@odyshell/cli/dist/index.js",
      ),
    ).toBe("pnpm");
    expect(
      packageManagerForPath(
        "C:\\Users\\Ada\\.bun\\install\\global\\node_modules\\@odyshell\\cli\\dist\\index.js",
      ),
    ).toBe("bun");
    expect(
      packageManagerForPath(
        "/Users/ada/.config/yarn/global/node_modules/@odyshell/cli/dist/index.js",
      ),
    ).toBe("yarn");
    expect(
      packageManagerForPath(
        "/usr/local/lib/node_modules/@odyshell/cli/dist/index.js",
      ),
    ).toBe("npm");
  });

  it("installs a verified release and restarts an existing Client service", async () => {
    const install = vi.fn<UpdateDependencies["install"]>(async () => {});
    const restart = vi.fn(async () => {});
    const dependencies = updateDependencies({ install, restart });

    await expect(
      updateClientPackage(
        "0.9.0",
        "/home/ada/.config/odyshell/client.json",
        false,
        dependencies,
      ),
    ).resolves.toMatchObject({
      currentVersion: "0.9.0",
      latestVersion: "0.9.1",
      updated: true,
      restarted: true,
    });
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]?.[0]).toMatch(/odyshell-cli-0\.9\.1\.tgz$/);
    expect(restart).toHaveBeenCalledWith(
      "/home/ada/.config/odyshell/client.json",
    );
  });

  it("restores the previous verified release when restart fails", async () => {
    const install = vi.fn<UpdateDependencies["install"]>(async () => {});
    const restart = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("restart failed"))
      .mockResolvedValueOnce();
    const dependencies = updateDependencies({ install, restart });

    await expect(
      updateClientPackage(
        "0.9.0",
        "/home/ada/.config/odyshell/client.json",
        false,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "client_update_failed" });
    expect(install.mock.calls.map(([path]) => path)).toEqual([
      expect.stringMatching(/odyshell-cli-0\.9\.1\.tgz$/),
      expect.stringMatching(/odyshell-cli-0\.9\.0\.tgz$/),
    ]);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("rejects untrusted registry artifacts before installation", async () => {
    const install = vi.fn<UpdateDependencies["install"]>(async () => {});
    const dependencies = updateDependencies({
      install,
      metadataTarball: "https://evil.example/odyshell.tgz",
    });

    await expect(
      updateClientPackage(
        "0.9.0",
        "/home/ada/.config/odyshell/client.json",
        false,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "client_update_artifact_untrusted" });
    expect(install).not.toHaveBeenCalled();
  });
});

function updateDependencies(options: {
  install?: UpdateDependencies["install"];
  restart?: UpdateDependencies["restart"];
  metadataTarball?: string;
} = {}): UpdateDependencies {
  const releases = {
    "0.9.0": Buffer.from("release 0.9.0"),
    "0.9.1": Buffer.from("release 0.9.1"),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.pathname.endsWith("/latest") || url.pathname.endsWith("/0.9.0")) {
        const version = url.pathname.endsWith("/latest") ? "0.9.1" : "0.9.0";
        const artifact = releases[version];
        return Response.json({
          version,
          dist: {
            integrity: `sha512-${createHash("sha512")
              .update(artifact)
              .digest("base64")}`,
            tarball:
              options.metadataTarball ??
              `https://registry.npmjs.org/@odyshell/cli/-/odyshell-cli-${version}.tgz`,
          },
        });
      }
      const version = url.pathname.endsWith("0.9.1.tgz") ? "0.9.1" : "0.9.0";
      return new Response(releases[version], {
        headers: {
          "content-length": String(releases[version].byteLength),
        },
      });
    },
  );
  return {
    fetch,
    install: options.install ?? (async () => {}),
    installedVersion: async () => "0.9.1",
    restart: options.restart ?? (async () => {}),
    serviceInstalled: async () => true,
  };
}
