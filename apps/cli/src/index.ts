import process from "node:process";
import { randomUUID } from "node:crypto";
import { allCapabilities, type Capability, type OperationAction } from "@odyshell/protocol";

const baseUrl = process.env.ODYSHELL_URL ?? "http://127.0.0.1:4100";
const agentKey = process.env.ODYSHELL_AGENT_KEY ?? "dev-agent-key";
const adminKey = process.env.ODYSHELL_ADMIN_KEY ?? "dev-admin-key";

async function api<T>(
  path: string,
  options: RequestInit & { admin?: boolean } = {},
): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      [options.admin ? "x-odyshell-admin-key" : "x-odyshell-agent-key"]:
        options.admin ? adminKey : agentKey,
      ...options.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`${response.status} ${body.error ?? response.statusText}`);
  return body;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function waitForSession(sessionId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const session = await api<Record<string, unknown>>(`/v1/sessions/${sessionId}`);
    if (session.status === "ready") return session;
    if (["failed", "closed", "expired"].includes(String(session.status))) {
      throw new Error(`Session ${String(session.status)}: ${String(session.error ?? "")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

type OperationResponse = {
  id: string;
  status: string;
  exitCode: number | null;
  error?: string | null;
  outputTruncated?: boolean;
  events: Array<{ sequence: number; stream: "stdout" | "stderr" | "result"; dataBase64: string }>;
};

async function waitForOperation(operationId: string): Promise<OperationResponse> {
  let lastSequence = -1;
  for (;;) {
    const operation = await api<OperationResponse>(`/v1/operations/${operationId}`);
    for (const event of operation.events) {
      if (event.sequence <= lastSequence) continue;
      lastSequence = event.sequence;
      const data = Buffer.from(event.dataBase64, "base64");
      if (event.stream === "stderr") process.stderr.write(data);
      else process.stdout.write(data);
    }
    if (!["queued", "delivered", "running"].includes(operation.status)) {
      if (operation.error) process.stderr.write(`\n${operation.error}\n`);
      return operation;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function openSession(
  machineId: string,
  capabilities: Capability[] = allCapabilities,
  ttlSeconds = 600,
): Promise<string> {
  const created = await api<{ id: string }>("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ machineId, profile: "workspace", ttlSeconds, capabilities }),
  });
  await waitForSession(created.id);
  return created.id;
}

async function createOperation(sessionId: string, action: OperationAction): Promise<OperationResponse> {
  const created = await api<{ id: string }>(`/v1/sessions/${sessionId}/operations`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: JSON.stringify({ action, timeoutSeconds: 120, maxOutputBytes: 1024 * 1024 }),
  });
  return waitForOperation(created.id);
}

async function main(): Promise<void> {
  const [command, subcommand, ...args] = process.argv.slice(2);

  if (command === "admin" && subcommand === "enrollment-token") {
    print(
      await api("/v1/admin/enrollment-tokens", {
        method: "POST",
        admin: true,
        body: JSON.stringify({ expiresInSeconds: Number(args[0] ?? 600) }),
      }),
    );
    return;
  }

  if (command === "machines") {
    print(await api("/v1/machines"));
    return;
  }

  if (command === "session" && subcommand === "open") {
    const machineId = args[0];
    if (!machineId) throw new Error("Usage: session open <machine-id> [ttl-seconds]");
    const sessionId = await openSession(machineId, allCapabilities, Number(args[1] ?? 600));
    print(await api(`/v1/sessions/${sessionId}`));
    return;
  }

  if (command === "session" && subcommand === "get") {
    if (!args[0]) throw new Error("Usage: session get <session-id>");
    print(await api(`/v1/sessions/${args[0]}`));
    return;
  }

  if (command === "session" && subcommand === "close") {
    if (!args[0]) throw new Error("Usage: session close <session-id>");
    print(await api(`/v1/sessions/${args[0]}`, { method: "DELETE" }));
    return;
  }

  if (command === "operation" && subcommand === "get") {
    if (!args[0]) throw new Error("Usage: operation get <operation-id>");
    print(await api(`/v1/operations/${args[0]}`));
    return;
  }

  if (command === "operation" && subcommand === "cancel") {
    if (!args[0]) throw new Error("Usage: operation cancel <operation-id>");
    print(await api(`/v1/operations/${args[0]}/cancel`, { method: "POST" }));
    return;
  }

  if (command === "exec") {
    const sessionId = subcommand;
    const [program, ...programArgs] = args;
    if (!sessionId || !program) throw new Error("Usage: exec <session-id> <program> [args...]");
    const result = await createOperation(sessionId, {
      kind: "process.exec",
      program,
      args: programArgs,
      cwd: ".",
      env: {},
    });
    process.exitCode = result.status === "succeeded" ? 0 : 1;
    return;
  }

  if (command === "shell") {
    const sessionId = subcommand;
    if (!sessionId || args.length === 0) throw new Error("Usage: shell <session-id> <command...>");
    const result = await createOperation(sessionId, {
      kind: "process.shell",
      command: args.join(" "),
      cwd: ".",
      env: {},
    });
    process.exitCode = result.status === "succeeded" ? 0 : 1;
    return;
  }

  if (command === "read") {
    const sessionId = subcommand;
    const path = args[0];
    if (!sessionId || !path) throw new Error("Usage: read <session-id> <relative-path>");
    const result = await createOperation(sessionId, { kind: "fs.read", path });
    process.exitCode = result.status === "succeeded" ? 0 : 1;
    return;
  }

  if (command === "write") {
    const sessionId = subcommand;
    const [path, ...content] = args;
    if (!sessionId || !path) throw new Error("Usage: write <session-id> <relative-path> <content...>");
    const result = await createOperation(sessionId, {
      kind: "fs.write",
      path,
      contentBase64: Buffer.from(content.join(" ")).toString("base64"),
      createParents: true,
    });
    process.exitCode = result.status === "succeeded" ? 0 : 1;
    return;
  }

  if (command === "run") {
    const machineId = subcommand;
    if (!machineId || args.length === 0) throw new Error("Usage: run <machine-id> <shell-command...>");
    const sessionId = await openSession(machineId, ["process.shell"], 300);
    try {
      const result = await createOperation(sessionId, {
        kind: "process.shell",
        command: args.join(" "),
        cwd: ".",
        env: {},
      });
      process.exitCode = result.status === "succeeded" ? 0 : 1;
    } finally {
      await api(`/v1/sessions/${sessionId}`, { method: "DELETE" });
    }
    return;
  }

  console.log(`Odyshell CLI

Commands:
  admin enrollment-token [ttl]
  machines
  session open <machine-id> [ttl]
  session get <session-id>
  session close <session-id>
  exec <session-id> <program> [args...]
  shell <session-id> <command...>
  read <session-id> <relative-path>
  write <session-id> <relative-path> <content...>
  operation get <operation-id>
  operation cancel <operation-id>
  run <machine-id> <shell-command...>`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
