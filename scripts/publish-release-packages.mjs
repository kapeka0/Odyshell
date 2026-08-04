import { readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  assertPublishedIntegrity,
  coordinatedReleaseVersion,
  publicPackages,
  releaseVersionFromTag,
  repositoryRoot,
  sha512Integrity,
} from "./release-shared.mjs";

const registryOrigin = "https://registry.npmjs.org";
const tag = process.argv[2];
if (!tag) throw new Error("A release tag is required");
const version = releaseVersionFromTag(tag);
await coordinatedReleaseVersion(version);

const artifactDirectory = resolve(
  process.env.ODYSHELL_RELEASE_ARTIFACTS ??
    resolve(repositoryRoot, ".odyshell", "release", version),
);
await mkdir(artifactDirectory, { recursive: true });

for (const packageDefinition of publicPackages) {
  const tarball = await packPackage(packageDefinition);
  const expectedIntegrity = await sha512Integrity(tarball);
  const existing = await registryVersion(packageDefinition.name, version);
  if (existing) {
    assertPublishedIntegrity(
      `${packageDefinition.name}@${version}`,
      expectedIntegrity,
      existing.dist?.integrity,
    );
    console.log(`${packageDefinition.name}@${version} already matches npm`);
    continue;
  }

  run(npmCommand(), [
    "publish",
    tarball,
    "--access",
    "public",
    "--registry",
    registryOrigin,
  ]);
  const published = await waitForPublishedVersion(
    packageDefinition.name,
    version,
  );
  assertPublishedIntegrity(
    `${packageDefinition.name}@${version}`,
    expectedIntegrity,
    published.dist?.integrity,
  );
}

async function packPackage(packageDefinition) {
  const before = new Set(await tarballs());
  run(pnpmCommand(), [
    "--dir",
    resolve(repositoryRoot, packageDefinition.directory),
    "pack",
    "--pack-destination",
    artifactDirectory,
    "--silent",
  ]);
  const created = (await tarballs()).filter((path) => !before.has(path));
  if (created.length !== 1) {
    throw new Error(
      `${packageDefinition.name} produced ${created.length} release tarballs`,
    );
  }
  return resolve(artifactDirectory, created[0]);
}

async function tarballs() {
  return (await readdir(artifactDirectory)).filter((path) => path.endsWith(".tgz"));
}

async function registryVersion(name, packageVersion) {
  const response = await fetch(
    `${registryOrigin}/${encodeURIComponent(name)}/${encodeURIComponent(packageVersion)}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `npm returned ${response.status} for ${name}@${packageVersion}`,
    );
  }
  return response.json();
}

async function waitForPublishedVersion(name, packageVersion) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const published = await registryVersion(name, packageVersion);
    if (published) return published;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`${name}@${packageVersion} did not become visible on npm`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
