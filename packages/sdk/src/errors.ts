export class ExpectedError extends Error {
  readonly expected = true;

  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "Error";
  }
}

export class ServerConnectionError extends ExpectedError {
  constructor(
    readonly serverUrl: string,
    cause: unknown,
  ) {
    super(
      `Unable to reach the Odyshell Server at ${serverUrl}.`,
      "server_unreachable",
      { cause },
    );
    this.name = "ServerConnectionError";
  }
}

export class ApiError extends ExpectedError {
  constructor(
    readonly status: number,
    readonly apiCode: string,
    readonly details?: unknown,
  ) {
    super(apiMessage(status, apiCode), apiCode);
    this.name = "ApiError";
  }
}

function apiMessage(status: number, code: string): string {
  if (code === "machine_ping_timeout") {
    return "The Server reached the machine connection, but the Client did not answer the ping in time.";
  }
  return `Odyshell API returned ${status}: ${code}`;
}
