import { execFile } from "node:child_process";
import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  clientServiceStatus,
  restartClientService,
} from "@odyshell/client";
import { ExpectedError } from "./errors.js";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@odyshell/cli";
const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const currentCliPath = fileURLToPath(import.meta.url);

type PackageRelease = {
  version: string;
  integrity: string;
  tarball: URL;
};

export type UpdateDependencies = {
  fetch: typeof globalThis.fetch;
  install: (tarballPath: string) => Promise<void>;
  installedVersion: () => Promise<string>;
  restart: (configPath: string) => Promise<void>;
  serviceInstalled: (configPath: string) => Promise<boolean>;
};

export type ClientUpdateResult = {
  currentVersion: string;
  latestVersion: string;
  compatible: boolean;
  updated: boolean;
  restarted: boolean;
};

export async function updateClientPackage(
  currentVersion: string,
  configPath: string,
  checkOnly = false,
  dependencies: UpdateDependencies = defaultDependencies,
): Promise<ClientUpdateResult> {
  const latest = await packageRelease("latest", dependencies.fetch);
  if (compareVersions(latest.version, currentVersion) <= 0) {
    return {
      currentVersion,
      latestVersion: latest.version,
      compatible: true,
      updated: false,
      restarted: false,
    };
  }
  const compatible = compatibleClientUpdate(currentVersion, latest.version);
  if (!compatible) {
    throw new ExpectedError(
      `Client ${latest.version} is not compatible with ${currentVersion}. Install the documented migration release explicitly.`,
      "client_update_incompatible",
    );
  }
  if (checkOnly) {
    return {
      currentVersion,
      latestVersion: latest.version,
      compatible,
      updated: false,
      restarted: false,
    };
  }

  const rollback = await packageRelease(currentVersion, dependencies.fetch);
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "odyshell-update-"),
  );
  const latestPath = join(
    temporaryDirectory,
    `odyshell-cli-${latest.version}.tgz`,
  );
  const rollbackPath = join(
    temporaryDirectory,
    `odyshell-cli-${rollback.version}.tgz`,
  );
  let changed = false;
  try {
    await Promise.all([
      downloadVerifiedPackage(latest, latestPath, dependencies.fetch),
      downloadVerifiedPackage(rollback, rollbackPath, dependencies.fetch),
    ]);
    changed = true;
    await dependencies.install(latestPath);
    const installed = await dependencies.installedVersion();
    if (installed !== latest.version) {
      throw new Error(
        `Installed version ${installed} does not match verified version ${latest.version}`,
      );
    }
    const shouldRestart = await dependencies.serviceInstalled(configPath);
    if (shouldRestart) {
      await dependencies.restart(configPath);
    }
    return {
      currentVersion,
      latestVersion: latest.version,
      compatible,
      updated: true,
      restarted: shouldRestart,
    };
  } catch (error) {
    if (changed) {
      try {
        await dependencies.install(rollbackPath);
        if (await dependencies.serviceInstalled(configPath)) {
          await dependencies.restart(configPath);
        }
      } catch (rollbackError) {
        throw new ExpectedError(
          `Client update failed and automatic rollback also failed. Reinstall ${PACKAGE_NAME}@${currentVersion}. Update error: ${errorMessage(error)}. Rollback error: ${errorMessage(rollbackError)}.`,
          "client_update_rollback_failed",
        );
      }
    }
    throw new ExpectedError(
      changed
        ? `Client update failed; ${currentVersion} was restored. ${errorMessage(error)}`
        : `Client update failed before installation. ${errorMessage(error)}`,
      "client_update_failed",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function compatibleClientUpdate(
  currentVersion: string,
  candidateVersion: string,
): boolean {
  const current = parseVersion(currentVersion);
  const candidate = parseVersion(candidateVersion);
  return current.major === candidate.major && current.minor === candidate.minor;
}

export function verifyPackageIntegrity(
  bytes: Uint8Array,
  integrity: string,
): boolean {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) return false;
  const expected = Buffer.from(match[1]!, "base64");
  const actual = createHash("sha512").update(bytes).digest();
  return (
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}

async function packageRelease(
  version: string,
  fetcher: typeof globalThis.fetch,
): Promise<PackageRelease> {
  const response = await fetcher(
    `${REGISTRY_ORIGIN}/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new ExpectedError(
      `Could not read ${PACKAGE_NAME}@${version} from npm (${response.status}).`,
      "client_update_registry_failed",
    );
  }
  const body = (await response.json()) as {
    version?: unknown;
    dist?: { integrity?: unknown; tarball?: unknown };
  };
  if (
    typeof body.version !== "string" ||
    typeof body.dist?.integrity !== "string" ||
    typeof body.dist.tarball !== "string"
  ) {
    throw new ExpectedError(
      "npm returned incomplete release metadata.",
      "client_update_metadata_invalid",
    );
  }
  parseVersion(body.version);
  const tarball = new URL(body.dist.tarball);
  if (
    tarball.protocol !== "https:" ||
    tarball.origin !== REGISTRY_ORIGIN
  ) {
    throw new ExpectedError(
      "npm returned an untrusted package URL.",
      "client_update_artifact_untrusted",
    );
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(body.dist.integrity)) {
    throw new ExpectedError(
      "npm did not provide a valid SHA-512 integrity value.",
      "client_update_integrity_missing",
    );
  }
  return {
    version: body.version,
    integrity: body.dist.integrity,
    tarball,
  };
}

async function downloadVerifiedPackage(
  release: PackageRelease,
  destination: string,
  fetcher: typeof globalThis.fetch,
): Promise<void> {
  const response = await fetcher(release.tarball, {
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download ${PACKAGE_NAME}@${release.version} (${response.status})`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PACKAGE_BYTES
  ) {
    throw new Error("Package exceeds the update size limit");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_PACKAGE_BYTES) {
      await reader.cancel();
      throw new Error("Package exceeds the update size limit");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, length);
  if (!verifyPackageIntegrity(bytes, release.integrity)) {
    throw new Error("Package SHA-512 integrity verification failed");
  }
  await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
}

function parseVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new ExpectedError(
      `Unsupported release version "${version}".`,
      "client_update_version_invalid",
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] - rightVersion[key];
    }
  }
  return 0;
}

async function installGlobalPackage(tarballPath: string): Promise<void> {
  const manager = packageManagerForPath(currentCliPath);
  const executable =
    process.platform === "win32" ? `${manager}.cmd` : manager;
  const args =
    manager === "npm"
      ? ["install", "--global", "--ignore-scripts", tarballPath]
      : manager === "pnpm"
        ? ["add", "--global", "--ignore-scripts", tarballPath]
        : manager === "yarn"
          ? ["global", "add", "--ignore-scripts", tarballPath]
          : ["add", "--global", "--ignore-scripts", tarballPath];
  await execFileAsync(executable, args, {
    windowsHide: true,
    timeout: 120_000,
  });
}

async function globalInstalledVersion(): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [currentCliPath, "--version"],
    {
      windowsHide: true,
      timeout: 30_000,
    },
  );
  const version = stdout.trim();
  try {
    parseVersion(version);
  } catch {
    throw new Error("Could not verify the globally installed CLI version");
  }
  return version;
}

export function packageManagerForPath(
  cliPath: string,
): "npm" | "pnpm" | "yarn" | "bun" {
  const normalized = cliPath.replaceAll("\\", "/").toLowerCase();
  if (
    normalized.includes("/pnpm/global/") ||
    normalized.includes("/pnpm-global/")
  ) {
    return "pnpm";
  }
  if (normalized.includes("/.bun/install/global/")) return "bun";
  if (
    normalized.includes("/yarn/data/global/") ||
    normalized.includes("/yarn/global/")
  ) {
    return "yarn";
  }
  return "npm";
}

const defaultDependencies: UpdateDependencies = {
  fetch: globalThis.fetch,
  install: installGlobalPackage,
  installedVersion: globalInstalledVersion,
  restart: restartClientService,
  serviceInstalled: async (configPath) =>
    (await clientServiceStatus(configPath)).installed,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
