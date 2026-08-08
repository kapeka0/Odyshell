import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export const coordinatedManifestPaths = [
  "apps/cli/package.json",
  "apps/client/package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/mcp/package.json",
  "packages/protocol/package.json",
];

export const publicPackages = [
  { name: "@odyshell/protocol", directory: "packages/protocol" },
  { name: "@odyshell/cli", directory: "apps/cli" },
];

export function releaseVersionFromTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(tag);
  if (!match) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  return match.slice(1).join(".");
}

export async function coordinatedReleaseVersion(expectedVersion) {
  const manifests = await Promise.all(
    coordinatedManifestPaths.map(async (path) => ({
      path,
      manifest: JSON.parse(
        await readFile(resolve(repositoryRoot, path), "utf8"),
      ),
    })),
  );
  const version = expectedVersion ?? manifests[0]?.manifest.version;
  if (typeof version !== "string") {
    throw new Error("The coordinated release version is missing");
  }
  for (const { path, manifest } of manifests) {
    if (manifest.version !== version) {
      throw new Error(
        `${path} uses ${String(manifest.version)} instead of ${version}`,
      );
    }
  }
  return version;
}

export function assertPublishedIntegrity(packageName, expected, actual) {
  if (typeof actual !== "string" || actual.length === 0) {
    throw new Error(`${packageName} has no published SHA-512 integrity`);
  }
  if (actual !== expected) {
    throw new Error(
      `${packageName} is already published with different contents`,
    );
  }
}

export async function sha512Integrity(path) {
  const bytes = await readFile(path);
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
