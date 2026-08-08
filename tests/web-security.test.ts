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
    const taskRoute = source("app/api/tasks/[taskId]/approve/route.ts");

    expect(identity).toContain("auth.api.getSession");
    expect(identity).toContain("auth.api.getActiveMember");
    expect(identityAuth).toContain("jwt: { issuer: configuration.baseUrl }");
    expect(authRoute).toContain("toNextJsHandler(auth)");
    expect(organizationRoute).toContain("requireCloudAdminRouteIdentity");
    expect(organizationRoute).toContain("auth.api.updateOrganization");
    expect(organizationRoute).not.toContain('z.literal("logging")');
    expect(taskRoute).toContain("requireCloudRouteIdentity");
    expect(taskRoute).not.toContain("role:");
  });

  it("allows only local post-authentication redirects", () => {
    expect(safeAuthRedirect("/dashboard/tasks", "/dashboard")).toBe(
      "/dashboard/tasks",
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
      agentId: "agent-'primary",
    });
    expect(command).toContain("ods --server 'https://self-hosted.example/api?next=a&mode=b' up");
    expect(command).toContain("--token 'ods_enroll_'\"'\"'_synthetic'");
    expect(command).toContain("--name 'production; touch /tmp/pwned'");
    expect(command).toContain("--agent-id 'agent-'\"'\"'primary'");
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

  it("publishes only Task and Command operational documentation", () => {
    const meta = readFileSync(resolve(webRoot, "content/docs/meta.json"), "utf8");
    expect(meta).toContain('"tasks"');
    expect(meta).toContain('"commands"');
    for (const page of ["sessions", "operations", "sdk", "migration", "event-sinks"]) {
      expect(meta).not.toContain(`"${page}"`);
      expect(existsSync(resolve(webRoot, `content/docs/${page}.mdx`))).toBe(false);
    }
  });

  it("removes legacy Session, Operation, Event Sink, and policy product routes", () => {
    for (const path of [
      "app/dashboard/sessions/page.tsx",
      "app/api/sessions/route.ts",
      "app/sessions/approve/page.tsx",
      "app/api/event-sink/route.ts",
      "app/dashboard/policies/page.tsx",
      "app/policies/approve/page.tsx",
      "components/session-list.tsx",
      "components/session-detail.tsx",
      "components/event-sink-settings.tsx",
    ]) {
      expect(existsSync(resolve(webSource, path))).toBe(false);
    }
  });

  it("loads Task state and Task audit into the shared dashboard context", () => {
    const server = readFileSync(resolve(root, "apps/server/src/control-http.ts"), "utf8");
    const database = readFileSync(
      resolve(root, "apps/server/src/task-database.ts"),
      "utf8",
    );
    const cloudApi = source("lib/cloud-api.ts");

    expect(server).toContain("taskDatabase.listTasks(parsed.data.organization.externalId, 100)");
    expect(server).toContain("taskDatabase.listAuditEvents(parsed.data.organization.externalId, 100)");
    expect(server).toContain("...controlEvents.map(controlEventView)");
    expect(server).not.toContain('notification.kind.startsWith("session.")');
    expect(database).toContain('selectFrom("taskAuditEvents")');
    expect(database).toContain('orderBy("createdAt", "desc")');
    expect(cloudApi).toContain("tasks: CloudTask[]");
    expect(cloudApi).not.toContain("CloudSession");
  });

  it("keeps Task approval role checks and Local Policy enforcement server-side", () => {
    const supervision = readFileSync(
      resolve(root, "apps/server/src/task-supervision-http.ts"),
      "utf8",
    );
    const tasks = readFileSync(resolve(root, "apps/server/src/tasks.ts"), "utf8");
    expect(supervision).toContain("cloudIdentitySchema");
    expect(supervision).toContain("humanId: identity.data.userId");
    expect(supervision).toContain("role: identity.data.role");
    expect(tasks).toContain("commandDecision");
    expect(tasks).toContain("localPolicy");
    expect(tasks).toContain('type: decision === "approve" ? "task.approved" : "task.denied"');
  });

  it("makes Tasks the minimal dashboard entrypoint without a parallel manual runtime", () => {
    const dashboard = source("app/dashboard/page.tsx");
    const taskList = source("components/task-list.tsx");
    const settings = source("app/dashboard/settings/page.tsx");
    const activity = source("components/control-event-list.tsx");

    expect(dashboard).toContain('redirect("/dashboard/tasks")');
    expect(existsSync(resolve(webSource, "components/workspace-canvas.tsx"))).toBe(false);
    expect(taskList).toContain("Only Tasks outside the current autonomy policy appear here.");
    expect(taskList).toContain("Approve this Task?");
    expect(settings).not.toContain("Logging");
    expect(settings).not.toContain("EventSinkSettings");
    expect(activity).toContain('label="Command"');
    expect(activity).toContain("event.metadata.command");
  });
});

function source(path: string): string {
  return readFileSync(resolve(webSource, path), "utf8");
}
