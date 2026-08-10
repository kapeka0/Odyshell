import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

const releaseVersion = "0.20.0";
const manifests = [
  "apps/cli/package.json",
  "apps/client/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/mcp/package.json",
  "packages/protocol/package.json",
].map(readManifest);

describe("0.20.0 release contract", () => {
  it("licenses the complete repository under Apache-2.0", () => {
    const license = readFileSync("LICENSE", "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0");
  });

  it("ships a verifiable encrypted Railway evacuation tool", () => {
    const backup = readFileSync("scripts/backup-railway.ps1", "utf8");
    expect(backup).toContain("Protect-CmsMessage");
    expect(backup).toContain("Unprotect-CmsMessage");
    expect(backup).toContain("pg_restore");
    expect(backup).toContain("Get-FileHash");
    expect(backup).not.toContain("Write-Output $railwayVariables");
  });

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
    ]);
    for (const manifest of publicPackages) {
      expect(manifest.publishConfig).toEqual({
        access: "public",
        registry: "https://registry.npmjs.org/",
      });
    }
  });

  it("ships compiled protocol exports", () => {
    const manifest = manifests.find(
      (candidate) => candidate.name === "@odyshell/protocol",
    );
    expect(JSON.stringify(manifest?.exports)).toContain("./dist/index.js");
    expect(JSON.stringify(manifest?.exports)).toContain("./dist/index.d.ts");
    expect(JSON.stringify(manifest?.exports)).not.toContain("./src/");
  });

  it("builds the protocol package before Web consumes its public entrypoint", () => {
    const webManifest = readFileSync(
      resolve(process.cwd(), "apps/web/package.json"),
      "utf8",
    );
    expect(webManifest).toContain('"prebuild": "pnpm --filter @odyshell/protocol build"');
    expect(webManifest).toContain('"pretypecheck": "pnpm --filter @odyshell/protocol build"');
    expect(
      readFileSync(resolve(process.cwd(), "apps/web/tsconfig.json"), "utf8"),
    ).not.toContain('"@odyshell/protocol"');
    const vitest = readFileSync(
      resolve(process.cwd(), "vitest.config.ts"),
      "utf8",
    );
    for (const workspacePackage of [
      "@odyshell/client",
      "@odyshell/protocol",
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
      resolve(process.cwd(), "packages/mcp/src/agentic.ts"),
      "utf8",
    );
    const client = readFileSync(
      resolve(process.cwd(), "apps/client/src/index.ts"),
      "utf8",
    );
    expect(cli).toContain(`.version("${releaseVersion}")`);
    expect(client).toContain(`CLIENT_VERSION = "${releaseVersion}"`);
    expect(
      mcp.match(
        new RegExp(`version: "${releaseVersion}"`, "g"),
      ),
    ).toHaveLength(1);
  });

  it("documents the cross-platform Machine CLI installation contract", () => {
    for (const path of ["README.md", "apps/cli/README.md"]) {
      const documentation = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(documentation).toContain("npm install --global @odyshell/cli");
      expect(documentation).toContain("Linux");
      expect(documentation).toContain("Windows");
      expect(documentation).toContain("macOS");
    }
    const cliManifest = readFileSync(
      resolve(process.cwd(), "apps/cli/package.json"),
      "utf8",
    );
    expect(cliManifest).not.toContain('"os": [');
    expect(
      readFileSync(
        resolve(process.cwd(), "apps/web/content/docs/commands.mdx"),
        "utf8",
      ),
    ).toContain("POST /v1/sessions/:sessionId/commands");

    const releaseNotes = readFileSync(
      resolve(process.cwd(), `docs/releases/${releaseVersion}.md`),
      "utf8",
    );
    expect(releaseNotes).not.toContain("ods client update");
  });

  it("rejects malformed release tags before packaging", () => {
    const check = resolve(process.cwd(), "scripts/release-check.mjs");
    expect(
      JSON.parse(
        execFileSync(process.execPath, [check, `v${releaseVersion}`], {
          encoding: "utf8",
        }),
      ),
    ).toMatchObject({ ok: true, tag: `v${releaseVersion}` });
    expect(() =>
      execFileSync(process.execPath, [check, `${releaseVersion};npm publish`], {
        stdio: "pipe",
      }),
    ).toThrow();
  });

  it("publishes through one protected and idempotent release workflow", () => {
    const root = process.cwd();
    const workflow = readFileSync(
      resolve(root, ".github/workflows/release.yml"),
      "utf8",
    );
    const publisher = readFileSync(
      resolve(root, "scripts/publish-release-packages.mjs"),
      "utf8",
    );
    const shared = readFileSync(
      resolve(root, "scripts/release-shared.mjs"),
      "utf8",
    );

    expect(workflow).toContain("environment: Production");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow.indexOf("ODYSHELL_RELEASE_ARTIFACTS")).toBeGreaterThan(
      workflow.indexOf("Publish verified npm packages"),
    );
    expect(workflow).not.toMatch(/uses: actions\/.+@v\d/u);
    expect(workflow.match(/uses: actions\/.+@[a-f0-9]{40}/gu)).toHaveLength(2);
    expect(workflow.indexOf("pnpm test:e2e")).toBeLessThan(
      workflow.indexOf("Create immutable release tag"),
    );
    const documentationSmoke = workflow.slice(
      workflow.indexOf("- name: Test public documentation"),
      workflow.indexOf("- run: pnpm test:e2e"),
    );
      expect(workflow).toContain(
        "BETTER_AUTH_SECRET: release-check-identity-secret-00000000",
      );
      expect(workflow).not.toContain("ODYSHELL_DEPLOYMENT_MODE");
      expect(workflow.match(/DATABASE_URL: postgresql:\/\/build:build@127\.0\.0\.1:5432\/build/g)).toHaveLength(2);
      expect(workflow).not.toContain("CLERK_SECRET_KEY");
    expect(workflow.indexOf("Publish verified npm packages")).toBeLessThan(
      workflow.indexOf("Create GitHub Release"),
    );
    expect(workflow).toContain("--verify-tag");
    expect(publisher).toContain("assertPublishedIntegrity");
    expect(publisher).toContain('"publish"');
    expect(shared).toContain("already published with different contents");
    expect(shared).toContain("@odyshell/protocol");
    expect(shared.indexOf("@odyshell/protocol")).toBeLessThan(
      shared.indexOf("@odyshell/cli"),
    );

    const sharedUrl = pathToFileURL(
      resolve(root, "scripts/release-shared.mjs"),
    ).href;
    const verifyIntegrity = (actual: string) =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { assertPublishedIntegrity } from ${JSON.stringify(sharedUrl)}; assertPublishedIntegrity("@odyshell/test@1.0.0", "sha512-expected", ${JSON.stringify(actual)});`,
        ],
        { stdio: "pipe" },
      );
    expect(() => verifyIntegrity("sha512-expected")).not.toThrow();
    expect(() => verifyIntegrity("sha512-hostile")).toThrow();
  });

  it("gates CI and releases on high-severity production dependency audits", () => {
    const root = process.cwd();
    const ci = readFileSync(
      resolve(root, ".github/workflows/ci.yml"),
      "utf8",
    );
    const release = readFileSync(
      resolve(root, ".github/workflows/release.yml"),
      "utf8",
    );
    const productionAudit = "pnpm audit --prod --audit-level high";

    expect(ci).toContain(productionAudit);
    expect(release).toContain(productionAudit);
    expect(release.indexOf(productionAudit)).toBeLessThan(
      release.indexOf("pnpm test:e2e"),
    );
  });

  it("audits release coherence with read-only GitHub permissions", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/release-audit.yml"),
      "utf8",
    );
    const audit = readFileSync(
      resolve(process.cwd(), "scripts/release-audit.mjs"),
      "utf8",
    );

    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toMatch(/uses: actions\/.+@v\d/u);
    expect(workflow.match(/uses: actions\/.+@[a-f0-9]{40}/gu)).toHaveLength(2);
    expect(audit).toContain("releases/latest");
    expect(audit).toContain("/latest");
    expect(audit).toContain("refs/tags/");
  });
});

function readManifest(path: string): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), path), "utf8"),
  ) as PackageManifest;
}
