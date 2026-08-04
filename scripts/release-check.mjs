import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  coordinatedReleaseVersion,
  publicPackages,
  releaseVersionFromTag,
  repositoryRoot,
} from "./release-shared.mjs";

const currentVersion = await coordinatedReleaseVersion();
const tag = process.argv[2] ?? `v${currentVersion}`;
const version = releaseVersionFromTag(tag);
await coordinatedReleaseVersion(version);

const notesPath = resolve(repositoryRoot, `docs/releases/${version}.md`);
const notes = await readFile(notesPath, "utf8");
if (!notes.startsWith(`# Odyshell ${version}\n`)) {
  throw new Error(`${notesPath} does not start with the release title`);
}

for (const { name, directory } of publicPackages) {
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, directory, "package.json"), "utf8"),
  );
  if (
    manifest.name !== name ||
    manifest.private === true ||
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig?.registry !== "https://registry.npmjs.org/"
  ) {
    throw new Error(`${name} is not configured as an intentional public package`);
  }
}

const cli = await readFile(
  resolve(repositoryRoot, "apps/cli/src/index.ts"),
  "utf8",
);
const client = await readFile(
  resolve(repositoryRoot, "apps/client/src/index.ts"),
  "utf8",
);
const mcp = await readFile(
  resolve(repositoryRoot, "packages/mcp/src/index.ts"),
  "utf8",
);
if (!cli.includes(`.version("${version}")`)) {
  throw new Error("The CLI version label is not coordinated");
}
if (!client.includes(`CLIENT_VERSION = "${version}"`)) {
  throw new Error("The Client version label is not coordinated");
}
if ((mcp.match(new RegExp(`version: "${version}"`, "gu")) ?? []).length !== 1) {
  throw new Error("The MCP version label is not coordinated");
}

console.log(
  JSON.stringify({ ok: true, tag, version, notesPath, publicPackages }, null, 2),
);
