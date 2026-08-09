import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { safeAuthRedirect } from "../apps/web/src/lib/auth-redirect.js";
import {
  machineEnrollmentCommand,
  posixShellArgument,
} from "../apps/web/src/lib/enrollment-command.js";
import { isPublicDocumentationPath } from "../apps/web/src/lib/public-documentation.js";
import { validDocumentationSearchQuery } from "../apps/web/src/lib/documentation-search.js";

const root = process.cwd();
const webRoot = resolve(root, "apps/web");
const webSource = resolve(webRoot, "src");

describe("web security boundaries", () => {
  it("keeps Human authentication and Organization authorization in server seams", () => {
    const identity = source("lib/identity.ts");
    const identityAuth = source("lib/identity-auth.ts");
    const authRoute = source("app/api/auth/[...all]/route.ts");
    const organizationRoute = source("app/api/organization-settings/route.ts");
    const sessionRoute = source("app/api/sessions/[sessionId]/approve/route.ts");

    expect(identity).toContain("auth.api.getSession");
    expect(identity).toContain("auth.api.getActiveMember");
    expect(identityAuth).toContain("jwt: { issuer: configuration.baseUrl }");
    expect(authRoute).toContain("toNextJsHandler(auth)");
    expect(organizationRoute).toContain("requireCloudAdminRouteIdentity");
    expect(organizationRoute).toContain("auth.api.updateOrganization");
    expect(organizationRoute).not.toContain('z.literal("logging")');
    expect(sessionRoute).toContain("requireCloudRouteIdentity");
    expect(sessionRoute).not.toContain("role:");
  });

  it("allows only local post-authentication redirects", () => {
    expect(safeAuthRedirect("/dashboard/sessions", "/dashboard")).toBe(
      "/dashboard/sessions",
    );
    for (const redirect of [
      "https://attacker.example/steal",
      "//attacker.example/steal",
      "/\\attacker.example/steal",
      "/dashboard\u0000https://attacker.example",
    ]) {
      expect(safeAuthRedirect(redirect, "/dashboard")).toBe("/dashboard");
    }
  });

  it("quotes every attacker-controlled Machine enrollment argument", () => {
    expect(posixShellArgument("value'with-quote")).toBe(
      `'value'"'"'with-quote'`,
    );
    const command = machineEnrollmentCommand({
      serverUrl: "https://self-hosted.example/api?next=a&mode=b",
      token: "ods_enroll_'_synthetic",
      machineName: "production; touch /tmp/pwned",
    });
    expect(command).toContain("ods --server 'https://self-hosted.example/api?next=a&mode=b' up");
    expect(command).toContain("--token 'ods_enroll_'\"'\"'_synthetic'");
    expect(command).toContain("--name 'production; touch /tmp/pwned'");
    expect(command).not.toContain("--agent-id");

    const secondCommand = machineEnrollmentCommand({
      serverUrl: "https://server.example",
      token: "ods_enroll_safe",
      machineName: "unassigned",
    });
    expect(secondCommand).not.toContain("--agent-id");
  });

  it("keeps documentation public while bounding its search input", () => {
    expect(isPublicDocumentationPath("/docs")).toBe(true);
    expect(isPublicDocumentationPath("/docs/quickstart.md")).toBe(true);
    expect(isPublicDocumentationPath("/dashboard")).toBe(false);
    expect(isPublicDocumentationPath("/docs-attacker")).toBe(false);
    expect(validDocumentationSearchQuery("machine")).toBe(true);
    expect(validDocumentationSearchQuery("\u0000machine")).toBe(false);
    expect(validDocumentationSearchQuery("a".repeat(201))).toBe(false);
  });

  it("publishes only Session and Command operational documentation", () => {
    const meta = readFileSync(resolve(webRoot, "content/docs/meta.json"), "utf8");
    expect(meta).toContain('"sessions"');
    expect(meta).toContain('"commands"');
    for (const page of ["tasks", "operations", "sdk", "migration", "event-sinks"]) {
      expect(meta).not.toContain(`"${page}"`);
      expect(existsSync(resolve(webRoot, `content/docs/${page}.mdx`))).toBe(false);
    }
  });

  it("removes legacy Task, Operation, Event Sink, and policy product routes", () => {
    for (const path of [
      "app/dashboard/tasks/page.tsx",
      "app/api/tasks/route.ts",
      "app/sessions/approve/page.tsx",
      "app/api/event-sink/route.ts",
      "app/dashboard/policies/page.tsx",
      "app/policies/approve/page.tsx",
      "components/task-list.tsx",
      "components/event-sink-settings.tsx",
    ]) {
      expect(existsSync(resolve(webSource, path))).toBe(false);
    }
  });

  it("loads Session state and Session audit into the shared dashboard context", () => {
    const server = readFileSync(resolve(root, "apps/server/src/control-http.ts"), "utf8");
    const database = readFileSync(
      resolve(root, "apps/server/src/session-database.ts"),
      "utf8",
    );
    const cloudApi = source("lib/cloud-api.ts");

    expect(server).toContain("sessionDatabase.listSessions(parsed.data.organization.externalId, 100)");
    expect(server).toContain("sessionDatabase.listAuditEvents(parsed.data.organization.externalId, 100)");
    expect(server).toContain("...controlEvents.map(controlEventView)");
    expect(server).not.toContain('notification.kind.startsWith("session.")');
    expect(database).toContain('selectFrom("sessionAuditEvents")');
    expect(database).toContain('orderBy("createdAt", "desc")');
    expect(cloudApi).toContain("sessions: CloudSession[]");
    expect(cloudApi).not.toContain("CloudTask");
  });

  it("keeps Session approval role checks and Local Policy enforcement server-side", () => {
    const supervision = readFileSync(
      resolve(root, "apps/server/src/session-supervision-http.ts"),
      "utf8",
    );
    const sessions = readFileSync(resolve(root, "apps/server/src/sessions.ts"), "utf8");
    expect(supervision).toContain("cloudIdentitySchema");
    expect(supervision).toContain("humanId: identity.data.userId");
    expect(supervision).toContain("role: identity.data.role");
    expect(sessions).toContain("commandDecision");
    expect(sessions).toContain("localPolicy");
    expect(sessions).toContain('type: decision === "approve" ? "session.approved" : "session.denied"');
  });

  it("restores the live canvas and canonical Session supervision runtime", () => {
    const dashboard = source("app/dashboard/page.tsx");
    const sessionList = source("components/session-list.tsx");
    const settings = source("app/dashboard/settings/page.tsx");
    const activity = source("components/control-event-list.tsx");

    expect(dashboard).toContain("<WorkspaceCanvas");
    expect(existsSync(resolve(webSource, "components/workspace-canvas.tsx"))).toBe(true);
    expect(sessionList).toContain("Standard Agents require a Human decision");
    expect(sessionList).toContain("Approve this Session?");
    expect(settings).not.toContain("Logging");
    expect(settings).not.toContain("EventSinkSettings");
    expect(activity).toContain('label="Command"');
    expect(activity).toContain("event.metadata.command");
  });

  it("keeps Operator and billing elevation behind confirmed server authorization", () => {
    const agentRoute = source("app/api/agents/[agentId]/route.ts");
    const billingRoute = source("app/api/billing/checkout/route.ts");
    const webhook = source("app/api/billing/webhook/route.ts");
    expect(agentRoute).toContain("requireCloudAdminRouteIdentity");
    expect(agentRoute).toContain("export async function PATCH");
    expect(billingRoute).toContain("requireCloudOwnerRouteIdentity");
    expect(webhook).toContain("constructEvent");
    expect(webhook).toContain("stripe-signature");
  });
});

function source(path: string): string {
  return readFileSync(resolve(webSource, path), "utf8");
}
