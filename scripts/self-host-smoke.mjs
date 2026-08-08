const webUrl = new URL(process.env.ODYSHELL_SMOKE_WEB_URL ?? "http://127.0.0.1:3000");
const serverUrl = new URL(
  process.env.ODYSHELL_SMOKE_SERVER_URL ?? "http://127.0.0.1:4100",
);
const webOrigin = new URL(
  process.env.ODYSHELL_SMOKE_WEB_ORIGIN ?? "http://localhost:3000",
).origin;
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const cookies = new Map();

await expectStatus(new URL("/health", serverUrl), 200, "Server health");
await expectStatus(new URL("/", webUrl), 200, "Web health");

const metadata = await request(
  new URL("/.well-known/oauth-protected-resource", serverUrl),
  { expectedStatus: 200, label: "OAuth protected-resource metadata" },
);
if (!sameLoopbackResource(metadata.body?.resource, new URL("/mcp", serverUrl))) {
  throw new Error("OAuth protected-resource metadata does not identify the MCP resource");
}

await expectStatus(
  new URL("/api/dashboard/context", webUrl),
  401,
  "Unauthenticated dashboard denial",
);
await expectStatus(new URL("/mcp", serverUrl), 401, "Unauthenticated MCP denial", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});

await authPost("/api/auth/sign-up/email", {
  name: "Self-host smoke",
  email: `self-host-smoke-${runId}@example.invalid`,
  password: `Odyshell-smoke-${runId}!`,
}, "Local account signup");

const organization = await authPost("/api/auth/organization/create", {
  name: "Self-host smoke",
  slug: `self-host-smoke-${runId}`,
}, "First Organization creation");
const organizationId = organization.body?.id ?? organization.body?.data?.id;
if (typeof organizationId !== "string") {
  throw new Error("First Organization creation did not return an Organization id");
}

await authPost(
  "/api/auth/organization/set-active",
  { organizationId },
  "Organization activation",
);
await request(new URL("/api/dashboard/context", webUrl), {
  expectedStatus: 200,
  label: "Authenticated dashboard context",
  headers: cookieHeaders(),
});

const secondOrganization = await request(
  new URL("/api/auth/organization/create", webUrl),
  {
    method: "POST",
    label: "Second Organization denial",
    headers: {
      ...cookieHeaders(),
      "content-type": "application/json",
      origin: webOrigin,
    },
    body: JSON.stringify({
      name: "Forbidden second Organization",
      slug: `forbidden-${runId}`,
    }),
  },
);
if (secondOrganization.status < 400 || secondOrganization.status >= 500) {
  throw new Error(
    `Second Organization denial returned unexpected status ${secondOrganization.status}`,
  );
}

process.stdout.write("Self-host smoke passed: identity, single-Organization, dashboard, and MCP boundaries.\n");

async function authPost(path, body, label) {
  return request(new URL(path, webUrl), {
    method: "POST",
    expectedStatus: 200,
    label,
    headers: {
      ...cookieHeaders(),
      "content-type": "application/json",
      origin: webOrigin,
    },
    body: JSON.stringify(body),
    captureCookies: true,
  });
}

async function expectStatus(url, expectedStatus, label, init = {}) {
  return request(url, { ...init, expectedStatus, label });
}

async function request(url, options) {
  const { expectedStatus, label, captureCookies = false, ...init } = options;
  const response = await fetch(url, { redirect: "manual", ...init });
  if (captureCookies) updateCookies(response.headers);
  const body = await readJson(response);
  if (expectedStatus !== undefined && response.status !== expectedStatus) {
    throw new Error(`${label} returned ${response.status}; expected ${expectedStatus}`);
  }
  return { status: response.status, body };
}

async function readJson(response) {
  if (!response.headers.get("content-type")?.includes("application/json")) return null;
  return response.json();
}

function updateCookies(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeaders() {
  if (cookies.size === 0) return {};
  return {
    cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
  };
}

function sameLoopbackResource(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const actual = new URL(candidate);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const sameHost = actual.hostname === expected.hostname ||
    (loopbackHosts.has(actual.hostname) && loopbackHosts.has(expected.hostname));
  return sameHost && actual.port === expected.port && actual.pathname === expected.pathname;
}
