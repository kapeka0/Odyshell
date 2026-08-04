import { execFileSync } from "node:child_process";
import process from "node:process";
import {
  coordinatedReleaseVersion,
  publicPackages,
  repositoryRoot,
} from "./release-shared.mjs";

const version = await coordinatedReleaseVersion();
const tag = `v${version}`;

execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], {
  cwd: repositoryRoot,
  stdio: "ignore",
});

for (const { name } of publicPackages) {
  const metadata = await json(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
  );
  if (metadata.version !== version) {
    throw new Error(
      `${name} latest is ${String(metadata.version)} instead of ${version}`,
    );
  }
}

const release = await json(
  "https://api.github.com/repos/kapeka0/Odyshell/releases/latest",
  process.env.GITHUB_TOKEN
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {},
);
if (
  release.tag_name !== tag ||
  release.draft === true ||
  release.prerelease === true
) {
  throw new Error(
    `GitHub latest is ${String(release.tag_name)} instead of ${tag}`,
  );
}

console.log(JSON.stringify({ ok: true, version, tag }, null, 2));

async function json(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json, application/json",
      "user-agent": "odyshell-release-audit",
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}
