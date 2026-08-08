import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const containerName = `odyshell-e2e-${randomUUID()}`;
const databasePassword = randomBytes(24).toString("base64url");
let containerStarted = false;

try {
  await run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--env",
    "POSTGRES_DB=odyshell",
    "--env",
    "POSTGRES_USER=odyshell",
    "--env",
    `POSTGRES_PASSWORD=${databasePassword}`,
    "--publish",
    "127.0.0.1::5432",
    "postgres:18-alpine",
  ]);
  containerStarted = true;

  await waitUntil(async () => {
    const result = await run(
      "docker",
      ["exec", containerName, "pg_isready", "-U", "odyshell"],
      { reject: false },
    );
    return result.code === 0;
  }, "PostgreSQL readiness");

  const published = (await run("docker", ["port", containerName, "5432/tcp"]))
    .stdout.trim()
    .split(/\r?\n/)[0];
  const port = published?.match(/:(\d+)$/)?.[1];
  if (!port) throw new Error(`Could not resolve PostgreSQL port: ${published}`);

  const databaseUrl =
    `postgresql://odyshell:${encodeURIComponent(databasePassword)}` +
    `@127.0.0.1:${port}/odyshell`;
  const packageManagerEntry = process.env.npm_execpath;
  if (!packageManagerEntry) {
    throw new Error("pnpm did not expose its executable entry point");
  }
  const packageManagerIsExecutable = packageManagerEntry.endsWith(".exe");
  const verification = await run(
    packageManagerIsExecutable ? packageManagerEntry : process.execPath,
    [
      ...(packageManagerIsExecutable ? [] : [packageManagerEntry]),
      "exec",
      "vitest",
      "run",
      "apps/server/test/control-database.integration.test.ts",
      "apps/server/test/task-database.integration.test.ts",
      "tests/task-http.test.ts",
      "tests/task-supervision-http.test.ts",
      "tests/task-mcp.test.ts",
      "tests/task-protocol.test.ts",
      "tests/platform.test.ts",
    ],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );
  process.stdout.write(verification.stdout);

  process.stdout.write(
    "Task-native E2E gate passed: Organization isolation, HTTP/MCP authority, " +
      "PostgreSQL lifecycle, and Client Local Policy.\n",
  );
} finally {
  if (containerStarted) {
    await run("docker", ["stop", containerName], { reject: false });
  }
}

async function waitUntil(check, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out`);
}

function run(command, args, options = {}) {
  const { env = process.env, inherit = false, reject = true } = options;
  return new Promise((resolve, rejectPromise) => {
    const child = spawn(command, args, {
      env,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (reject && result.code !== 0) {
        rejectPromise(
          new Error(
            `${command} exited with ${result.code}${stderr ? `\n${stderr.trim()}` : ""}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}
