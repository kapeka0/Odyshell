const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:3000");

async function expectResponse(path, expectedStatus, expectedType) {
  const response = await fetch(new URL(path, baseUrl), {
    redirect: "manual",
  });
  if (response.status !== expectedStatus) {
    throw new Error(
      `${path} returned ${response.status}; expected ${expectedStatus}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith(expectedType)) {
    throw new Error(
      `${path} returned ${contentType || "no content type"}; expected ${expectedType}`,
    );
  }
  return response;
}

await expectResponse("/docs", 200, "text/html");
await expectResponse("/docs/quickstart", 200, "text/html");
await expectResponse("/docs.md", 200, "text/markdown");
await expectResponse("/docs/quickstart.md", 200, "text/markdown");
await expectResponse("/llms.txt", 200, "text/plain");
const llmsFull = await expectResponse("/llms-full.txt", 200, "text/plain");
await expectResponse("/api/search?query=machine", 200, "application/json");
await expectResponse("/api/search?query=%00", 400, "application/json");
await expectResponse(
  `/api/search?query=${"a".repeat(201)}`,
  400,
  "application/json",
);
await expectResponse("/docs/not-a-real-page", 404, "text/html");
await expectResponse("/docs/not-a-real-page.md", 404, "text/html");

const privateResponse = await fetch(new URL("/dashboard", baseUrl), {
  redirect: "manual",
});
const redirectStatuses = new Set([302, 303, 307, 308]);
const deniedStatuses = new Set([401, 403]);
const location = privateResponse.headers.get("location");
const securelyDenied =
  deniedStatuses.has(privateResponse.status) ||
  (redirectStatuses.has(privateResponse.status) &&
    location !== null &&
    new URL(location, baseUrl).pathname.startsWith("/sign-in"));
if (!securelyDenied) {
  throw new Error(
    `/dashboard returned ${privateResponse.status} without a sign-in redirect or explicit denial`,
  );
}

const corpus = await llmsFull.text();
if (
  /\bods_(?:agent|cli|enroll)_[A-Za-z0-9_-]{16,}\b/.test(corpus) ||
  corpus.includes("dev-agent-key") ||
  corpus.includes("dev-admin-key")
) {
  throw new Error("/llms-full.txt contains a credential pattern");
}

console.log(`Documentation smoke test passed for ${baseUrl.origin}`);
