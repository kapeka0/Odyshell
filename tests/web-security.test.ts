import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  googleSsoRedirects,
  safeAuthRedirect,
} from "../apps/web/src/lib/auth-redirect.js";
import {
  facehashAvatarPath,
  safeFacehashIdentity,
  vercelAvatarUrl,
} from "../apps/web/src/lib/avatar.js";
import {
  machineEnrollmentCommand,
  posixShellArgument,
} from "../apps/web/src/lib/enrollment-command.js";
import { agentLoginCommand } from "../apps/web/src/lib/agent-command.js";
import { machinePlatform } from "../apps/web/src/lib/machine-platform.js";
import { selectDisplayLabel } from "../apps/web/src/lib/select-label.js";
import { isPublicDocumentationPath } from "../apps/web/src/lib/public-documentation.js";
import { validDocumentationSearchQuery } from "../apps/web/src/lib/documentation-search.js";
import {
  activeUserTheme,
  nextUserTheme,
} from "../apps/web/src/lib/theme-cycle.js";
import {
  isReadOnlyPreset,
  readOnlyCapabilities,
  toggleReadOnlyPreset,
} from "../apps/web/src/lib/agent-access-options.js";
import {
  deviceApprovalErrorPath,
  deviceApprovalReason,
  deviceCodeSchema,
} from "../apps/web/src/lib/device-activation.js";
import {
  sessionApprovalCodeSchema,
  sessionApprovalErrorPath,
} from "../apps/web/src/lib/session-approval.js";
import { statusTone } from "../apps/web/src/lib/status-tone.js";

describe("web authentication boundaries", () => {
  it("initializes Clerk for every authenticated approval and API route", () => {
    const proxy = readFileSync(
      resolve(process.cwd(), "apps/web/src/proxy.ts"),
      "utf8",
    );
    expect(proxy).toContain('"/sessions/:path*"');
    expect(proxy).toContain('"/policies/:path*"');
    expect(proxy).toContain('"/sso-callback/:path*"');
    expect(proxy).toContain('"/api/:path*"');
  });

  it("keeps documentation pages outside the Clerk UI boundary", () => {
    expect(isPublicDocumentationPath("/docs")).toBe(true);
    expect(isPublicDocumentationPath("/docs/quickstart")).toBe(true);
    expect(isPublicDocumentationPath("/docs/quickstart.md")).toBe(true);
    expect(isPublicDocumentationPath("/dashboard")).toBe(false);
    expect(isPublicDocumentationPath("/docs-attacker")).toBe(false);
  });

  it("bounds public documentation search input", () => {
    expect(validDocumentationSearchQuery("machine")).toBe(true);
    expect(validDocumentationSearchQuery("")).toBe(true);
    expect(validDocumentationSearchQuery("\u0000machine")).toBe(false);
    expect(validDocumentationSearchQuery("a".repeat(201))).toBe(false);
  });

  it("preserves valid local activation redirects", () => {
    expect(
      safeAuthRedirect("/activate?code=ABCD-EFGH", "/dashboard"),
    ).toBe("/activate?code=ABCD-EFGH");
  });

  it.each([
    "https://attacker.example/steal",
    "//attacker.example/steal",
    "/\\attacker.example/steal",
    "/dashboard\u0000https://attacker.example",
  ])("rejects unsafe auth redirect %s", (redirect) => {
    expect(safeAuthRedirect(redirect, "/dashboard")).toBe("/dashboard");
  });

  it("keeps Google SSO completion on local Odyshell routes", () => {
    expect(googleSsoRedirects("/activate?code=ABCD-EFGH")).toEqual({
      redirectUrl: "/activate?code=ABCD-EFGH",
      redirectCallbackUrl:
        "/sso-callback?redirect_url=%2Factivate%3Fcode%3DABCD-EFGH",
    });
    expect(googleSsoRedirects("https://attacker.example/steal")).toEqual({
      redirectUrl: "/dashboard",
      redirectCallbackUrl: "/sso-callback?redirect_url=%2Fdashboard",
    });
  });

  it("normalizes valid device codes without accepting ambiguous characters", () => {
    expect(deviceCodeSchema.parse("abcd-efgh")).toBe("ABCDEFGH");
    expect(deviceCodeSchema.safeParse("ABCD-EFGI").success).toBe(false);
    expect(deviceCodeSchema.safeParse("ABCD-EFG0").success).toBe(false);
  });

  it("allowlists approval failures instead of reflecting arbitrary data", () => {
    const secret = "ods_session_secret";
    expect(deviceApprovalReason(secret)).toBe("approval_failed");
    expect(deviceApprovalErrorPath(secret)).toBe(
      "/activate/error?reason=approval_failed",
    );
    expect(deviceApprovalErrorPath(secret)).not.toContain(secret);
  });

  it("keeps the upcoming Skill command static and separate from activation data", () => {
    const successPage = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/src/app/activate/success/page.tsx",
      ),
      "utf8",
    );

    expect(successPage).toContain(
      "npx skills add kapeka0/Odyshell --skill odyshell",
    );
    expect(successPage).toContain("Coming soon");
    expect(successPage).toContain("<CopyableValue");
    expect(successPage).not.toContain("searchParams");
    expect(successPage).not.toContain("deviceCode");
    expect(successPage).not.toContain("approvalCode");
  });

  it("accepts only opaque Session approval codes and never reflects them", () => {
    const code = `ods_approval_${"a".repeat(32)}`;
    expect(sessionApprovalCodeSchema.parse(code)).toBe(code);
    expect(
      sessionApprovalCodeSchema.safeParse(`https://attacker.example/${code}`)
        .success,
    ).toBe(false);
    expect(sessionApprovalCodeSchema.safeParse("ods_session_secret").success).toBe(
      false,
    );
    expect(sessionApprovalErrorPath(code)).toBe(
      "/sessions/approve/error?reason=approval_failed",
    );
    expect(sessionApprovalErrorPath(code)).not.toContain(code);
  });

  it("keeps Session approval and denial behind the same authenticated boundary", () => {
    for (const decision of ["approve", "deny"]) {
      const route = readFileSync(
        resolve(
          process.cwd(),
          `apps/web/src/app/api/session-requests/${decision}/route.ts`,
        ),
        "utf8",
      );
      expect(route).toContain("requireCloudRouteIdentity()");
      expect(route).toContain("sessionApprovalCodeSchema");
      expect(route).not.toContain("approvalCode: request");
    }
  });

  it("uses an opaque identity for colored avatars without letters or email addresses", () => {
    const url = vercelAvatarUrl("org_2abc");
    expect(url).toBe("https://avatar.vercel.sh/org_2abc.svg?size=64");
    expect(url).not.toContain("text=");
    expect(url).not.toContain("@");
    expect(facehashAvatarPath("user_2abc")).toBe(
      "/api/avatar?name=user_2abc&size=128&showInitial=false",
    );
    expect(safeFacehashIdentity("user_2abc")).toBe("user_2abc");
    expect(safeFacehashIdentity("person@example.com")).toBeNull();
    expect(safeFacehashIdentity("x".repeat(257))).toBeNull();
  });

  it("quotes self-hosted enrollment arguments before placing them in a shell command", () => {
    const command = machineEnrollmentCommand({
      serverUrl: "https://self-hosted.example/api?mode=one&next=ignored",
      token: "ods_enroll_safe",
      machineName: "rpi5",
      capabilities: ["fs.read", "docker.logs"],
    });

    expect(command).toContain(
      "--server 'https://self-hosted.example/api?mode=one&next=ignored'",
    );
    expect(command).toContain("--allow 'fs.read,docker.logs'");
    expect(posixShellArgument("value'with-quote")).toBe(
      "'value'\"'\"'with-quote'",
    );
  });

  it("quotes agent credentials before placing them in a shell command", () => {
    const command = agentLoginCommand({
      serverUrl: "https://self-hosted.example/api?mode=one&next=ignored",
      token: "ods_agent_'_safe",
    });

    expect(command).toBe(
      "ods --server 'https://self-hosted.example/api?mode=one&next=ignored' login --agent-token 'ods_agent_'\"'\"'_safe'",
    );
  });

  it("allowlists machine platforms received from Client runtime data", () => {
    expect(machinePlatform({ hostPlatform: "linux" })).toBe("Linux");
    expect(machinePlatform({ hostPlatform: "macos" })).toBe("macOS");
    expect(machinePlatform({ hostPlatform: "windows" })).toBe("Windows");
    expect(machinePlatform({ hostPlatform: "<script>alert(1)</script>" })).toBe(
      "Unknown",
    );
    expect(machinePlatform(null)).toBe("Unknown");
  });

  it("normalizes persisted user theme values", () => {
    expect(activeUserTheme(undefined)).toBe("system");
    expect(activeUserTheme("light")).toBe("light");
    expect(activeUserTheme("dark")).toBe("dark");
    expect(activeUserTheme("unsafe")).toBe("system");
    expect(nextUserTheme("system")).toBe("light");
    expect(nextUserTheme("light")).toBe("dark");
    expect(nextUserTheme("dark")).toBe("system");
  });

  it("replaces unsafe capabilities with read-only and clears the preset on a second click", () => {
    const enabled = toggleReadOnlyPreset(["fs.write", "process.shell"]);
    expect(enabled).toEqual(readOnlyCapabilities);
    expect(isReadOnlyPreset(enabled)).toBe(true);
    expect(toggleReadOnlyPreset(enabled)).toEqual([]);
    expect(isReadOnlyPreset(["fs.read"])).toBe(false);
  });
});

describe("dashboard navigation performance boundary", () => {
  it("loads remote dashboard context in the layout, not each child route", () => {
    const dashboardRoot = resolve(
      process.cwd(),
      "apps/web/src/app/dashboard",
    );
    const layout = readFileSync(resolve(dashboardRoot, "layout.tsx"), "utf8");
    expect(layout.match(/dashboardState\(/gu)).toHaveLength(1);

    for (const route of [
      "page.tsx",
      "machines/page.tsx",
      "agents/page.tsx",
      "activity/page.tsx",
      "settings/page.tsx",
    ]) {
      const source = readFileSync(resolve(dashboardRoot, route), "utf8");
      expect(source).not.toContain("dashboardState(");
      expect(source).not.toContain("cloudRequest(");
      expect(source).toContain("useDashboard()");
    }
    expect(
      readFileSync(resolve(dashboardRoot, "access/page.tsx"), "utf8"),
    ).toContain('redirect("/dashboard/agents")');
  });

  it("refreshes live dashboard state from the shared provider", () => {
    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    const provider = readFileSync(
      resolve(componentsRoot, "dashboard-provider.tsx"),
      "utf8",
    );
    expect(provider).toContain("<DashboardLiveRefresh");
  });

  it("keeps live status dots stable while only their halo animates", () => {
    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    const statusDot = readFileSync(
      resolve(componentsRoot, "status-dot.tsx"),
      "utf8",
    );
    expect(statusDot).toContain("motion-safe:animate-ping");
    expect(statusDot).not.toContain("animate-pulse");
    for (const file of ["machine-list.tsx", "workspace-canvas.tsx"]) {
      expect(
        readFileSync(resolve(componentsRoot, file), "utf8"),
      ).toContain("<StatusDot");
    }
  });

  it("keeps table filter labels stable while their selected values change", () => {
    const dataTable = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/src/components/data-table.tsx",
      ),
      "utf8",
    );
    expect(selectDisplayLabel("Dates", [], "all")).toBe("All Dates");
    expect(
      selectDisplayLabel(
        "Dates",
        [{ label: "Last 7 days", value: "7d" }],
        "7d",
      ),
    ).toBe("Last 7 days");
    expect(dataTable).toContain("selectDisplayLabel(");
    expect(dataTable).not.toContain("<SelectValue />");
  });

  it("uses one default geometry for form controls", () => {
    const uiRoot = resolve(
      process.cwd(),
      "apps/web/src/components/ui",
    );
    const button = readFileSync(resolve(uiRoot, "button.tsx"), "utf8");
    const input = readFileSync(resolve(uiRoot, "input.tsx"), "utf8");
    const select = readFileSync(resolve(uiRoot, "select.tsx"), "utf8");

    expect(button).toContain('"h-10 gap-2');
    expect(input).toContain('"h-10 w-full');
    expect(input).toContain("px-3 py-2");
    expect(select).toContain("data-[size=default]:h-10");
    expect(select).toContain("px-3");
  });

  it("keeps loading feedback in forms and toast notifications above dialogs", () => {
    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    for (const file of [
      "agent-list.tsx",
      "device-activation.tsx",
      "enroll-machine.tsx",
      "machine-list.tsx",
    ]) {
      expect(
        readFileSync(resolve(componentsRoot, file), "utf8"),
      ).not.toContain('type: "loading"');
    }
    expect(
      readFileSync(resolve(componentsRoot, "ui/toast.tsx"), "utf8"),
    ).toContain("z-[100]");
    expect(
      readFileSync(resolve(componentsRoot, "enroll-machine.tsx"), "utf8"),
    ).toContain("wrap");
    expect(
      readFileSync(resolve(componentsRoot, "copyable-value.tsx"), "utf8"),
    ).toContain("whitespace-pre-wrap break-all");
    const appShell = readFileSync(
      resolve(componentsRoot, "app-shell.tsx"),
      "utf8",
    );
    expect(appShell).toContain(
      '<AppSidebar variant="inset" className="border-r border-border" />',
    );
    expect(appShell).not.toContain("<Separator");
    expect(appShell).not.toContain("{title}");
    expect(
      readFileSync(resolve(componentsRoot, "workspace-canvas.tsx"), "utf8"),
    ).toContain("animated: animateConnections");
  });

  it("keeps dashboard navigation concise and removes the sidebar rail", () => {
    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    const sidebar = readFileSync(
      resolve(componentsRoot, "app-sidebar.tsx"),
      "utf8",
    );
    const userMenu = readFileSync(
      resolve(componentsRoot, "sidebar-user.tsx"),
      "utf8",
    );
    expect(sidebar).not.toContain("SidebarRail");
    expect(sidebar).not.toContain("Workspace settings");
    expect(sidebar).toContain("workspaceSettingsItems");
    expect(sidebar).toContain('label="Manage"');
    expect(sidebar).not.toContain('className="mt-auto"');
    expect(userMenu).not.toContain("User settings");
    expect(userMenu).toContain("nextUserTheme(activeTheme)");
    expect(userMenu).toContain('className="min-w-56 p-2"');
    expect(userMenu).toContain('className="flex flex-col gap-1"');
    expect(userMenu).toContain('className="px-2 py-2"');
    expect(userMenu.indexOf("nextUserTheme(activeTheme)")).toBeLessThan(
      userMenu.indexOf('href="/dashboard/user-settings"'),
    );
    expect(userMenu.indexOf('href="/dashboard/user-settings"')).toBeLessThan(
      userMenu.indexOf("void signOut"),
    );
    for (const label of ["System", "Light", "Dark", "Settings", "Sign out"]) {
      expect(userMenu).toContain(label);
    }
    expect(
      readFileSync(
        resolve(componentsRoot, "control-event-list.tsx"),
        "utf8",
      ),
    ).not.toContain("Security-relevant changes without commands");
    expect(
      readFileSync(
        resolve(componentsRoot, "control-event-list.tsx"),
        "utf8",
      ),
    ).not.toContain("Privacy-minimal");
    const dashboardShell = readFileSync(
      resolve(componentsRoot, "app-shell.tsx"),
      "utf8",
    );
    expect(dashboardShell).toContain("border-b");
    expect(dashboardShell).toContain(
      'className="border-r border-border"',
    );
    const activityPage = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/src/app/dashboard/activity/page.tsx",
      ),
      "utf8",
    );
    expect(activityPage).toContain("controlEventRetentionDays");
    expect(activityPage).toContain("-day retention");
    const dataTable = readFileSync(
      resolve(componentsRoot, "data-table.tsx"),
      "utf8",
    );
    expect(dataTable).toContain("summaryLabel");
    expect(dataTable).toContain(
      "{table.getFilteredRowModel().rows.length} results",
    );
    expect(dataTable).toContain(
      'className="flex items-center justify-center gap-4 text-sm text-muted-foreground"',
    );
    for (const page of ["activity", "agents", "machines", "settings"]) {
      expect(
        readFileSync(
          resolve(
            process.cwd(),
            `apps/web/src/app/dashboard/${page}/page.tsx`,
          ),
          "utf8",
        ),
      ).not.toContain('eyebrow="Workspace"');
    }
    const userSettings = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/src/app/dashboard/user-settings/page.tsx",
      ),
      "utf8",
    );
    expect(userSettings).toContain("<Empty");
    expect(userSettings).not.toContain("useTheme");
    expect(userSettings).not.toContain("useClerk");
    expect(userSettings).not.toContain("Appearance");
    expect(userSettings).not.toContain("Sign out");
    const interfaceRules = readFileSync(
      resolve(process.cwd(), "apps/web/UI_RULES.md"),
      "utf8",
    );
    expect(interfaceRules).toContain(
      "Begin every user-facing label with a capital letter",
    );
  });

  it("keeps the workspace canvas dot contrast between borders and text", () => {
    const canvas = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/src/components/workspace-canvas.tsx",
      ),
      "utf8",
    );
    expect(canvas).toContain('color="var(--color-rule-strong)"');
    expect(canvas).not.toContain('color="var(--muted-foreground)"');
  });

  it("keeps operational status colors semantic and fail-safe", () => {
    expect(statusTone("active")).toBe("success");
    expect(statusTone("recorded")).toBe("info");
    expect(statusTone("approved")).toBe("info");
    expect(statusTone("paused")).toBe("warning");
    expect(statusTone("pending")).toBe("warning");
    expect(statusTone("denied")).toBe("danger");
    expect(statusTone("revoked")).toBe("danger");
    expect(statusTone("disabled")).toBe("neutral");
    expect(statusTone("unexpected-status")).toBe("neutral");

    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    for (const file of [
      "agent-list.tsx",
      "agent-policy-list.tsx",
      "control-event-list.tsx",
      "machine-list.tsx",
      "session-list.tsx",
    ]) {
      expect(readFileSync(resolve(componentsRoot, file), "utf8")).toContain(
        "<StatusBadge",
      );
    }
    expect(
      readFileSync(resolve(process.cwd(), "apps/web/UI_RULES.md"), "utf8"),
    ).toMatch(/Always pair color\s+with a text label/);
  });

  it("copies important table values without recording them in feedback", () => {
    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    const copyable = readFileSync(
      resolve(componentsRoot, "copyable-value.tsx"),
      "utf8",
    );
    expect(copyable).toContain("navigator.clipboard.writeText(value)");
    expect(copyable).toContain('aria-live="polite"');
    expect(copyable).not.toContain("toast");
    expect(copyable).not.toContain("hover:text-foreground");
    expect(copyable).toContain('variant === "command"');
    expect(copyable).toContain('className="absolute top-3 right-3"');
    expect(copyable).toContain('size="icon-sm"');
    for (const file of [
      resolve(componentsRoot, "enroll-machine.tsx"),
      resolve(
        process.cwd(),
        "apps/web/src/app/activate/success/page.tsx",
      ),
    ]) {
      const generatedCommand = readFileSync(file, "utf8");
      expect(generatedCommand).toContain("border bg-muted/50");
      expect(generatedCommand).toContain('variant="command"');
      expect(generatedCommand).not.toContain("bg-foreground p-");
      expect(generatedCommand).not.toContain("hover:bg-muted/70");
    }
    for (const file of [
      "machine-list.tsx",
      "agent-list.tsx",
      "control-event-list.tsx",
    ]) {
      expect(
        readFileSync(resolve(componentsRoot, file), "utf8"),
      ).toContain("<CopyableValue");
    }
  });

  it("uses dedicated, bounded creation routes with concise form actions", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const componentsRoot = resolve(webRoot, "components");
    const agentList = readFileSync(
      resolve(componentsRoot, "agent-list.tsx"),
      "utf8",
    );
    const machineForm = readFileSync(
      resolve(componentsRoot, "enroll-machine.tsx"),
      "utf8",
    );
    const agentsPage = readFileSync(
      resolve(webRoot, "app/dashboard/agents/page.tsx"),
      "utf8",
    );

    expect(agentList).toContain('title="Agent"');
    expect(agentList).not.toContain("Agent Access");
    expect(agentsPage).not.toContain('href="/dashboard/agents/add"');
    expect(machineForm).toContain("justify-end");
    expect(machineForm.indexOf("Cancel")).toBeLessThan(
      machineForm.lastIndexOf('"Add"'),
    );
    expect(machineForm).not.toContain("ArrowLeftIcon");
  });

  it("shows allowlisted machine platform data and links to public documentation", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const machineList = readFileSync(
      resolve(webRoot, "components/machine-list.tsx"),
      "utf8",
    );
    const landing = readFileSync(
      resolve(webRoot, "app/page.tsx"),
      "utf8",
    );
    const quickstart = readFileSync(
      resolve(process.cwd(), "apps/web/content/docs/quickstart.mdx"),
      "utf8",
    );
    expect(machineList).toContain('title="Platform"');
    expect(machineList).toContain("machinePlatform(machine.runtime)");
    expect(landing).toContain('href="/docs"');
    expect(landing).toContain("Read the docs");
    expect(quickstart).toContain("ods login");
    expect(quickstart).toContain("ods ping my-machine");
  });

  it("uses route-specific skeletons and theme-aware browser icons", () => {
    const dashboardRoot = resolve(
      process.cwd(),
      "apps/web/src/app/dashboard",
    );
    const dashboardSkeletons = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/src/components/dashboard-skeletons.tsx",
      ),
      "utf8",
    );
    const tableSkeleton = dashboardSkeletons.slice(
      dashboardSkeletons.indexOf("export function TablePageSkeleton"),
      dashboardSkeletons.indexOf("export function SettingsPageSkeleton"),
    );
    const uiRules = readFileSync(
      resolve(process.cwd(), "apps/web/UI_RULES.md"),
      "utf8",
    );
    for (const route of [
      "machines/loading.tsx",
      "machines/add/loading.tsx",
      "agents/loading.tsx",
      "agents/add/loading.tsx",
      "activity/loading.tsx",
      "settings/loading.tsx",
      "user-settings/loading.tsx",
    ]) {
      expect(
        readFileSync(resolve(dashboardRoot, route), "utf8"),
      ).toContain("Skeleton");
    }
    expect(uiRules).toContain(
      "Every visual change also reviews its route-level skeleton",
    );
    const resultsSkeletonIndex = tableSkeleton.indexOf(
      'aria-label="Loading results"',
    );
    const tableSkeletonIndex = tableSkeleton.indexOf(
      'className="overflow-hidden rounded-lg border"',
    );
    const paginationSkeletonIndex = tableSkeleton.indexOf(
      'aria-label="Loading pagination"',
    );
    expect(resultsSkeletonIndex).toBeGreaterThan(-1);
    expect(resultsSkeletonIndex).toBeLessThan(tableSkeletonIndex);
    expect(paginationSkeletonIndex).toBeGreaterThan(tableSkeletonIndex);
    const rootLayout = readFileSync(
      resolve(process.cwd(), "apps/web/src/app/layout.tsx"),
      "utf8",
    );
    expect(rootLayout).toContain("prefers-color-scheme: light");
    expect(rootLayout).toContain("prefers-color-scheme: dark");
    expect(rootLayout).toContain("odyshell-square-light.svg");
    expect(rootLayout).toContain("odyshell-square-dark.svg");
  });

  it("shows persistent Agents and temporary Sessions without leaking Timeline payloads", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const canvas = readFileSync(
      resolve(webRoot, "components/workspace-canvas.tsx"),
      "utf8",
    );
    const sidebar = readFileSync(
      resolve(webRoot, "components/app-sidebar.tsx"),
      "utf8",
    );
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );
    const sanitizer = server.slice(
      server.indexOf("function privacyMinimalTimelineMetadata("),
      server.indexOf("const agentAccessDependencies"),
    );

    expect(canvas).toContain("context.agents");
    expect(canvas).toContain('type: "session"');
    expect(canvas).toContain("session.targets.map");
    expect(sidebar).toContain('href: "/dashboard/sessions"');
    expect(sanitizer).toContain('"machineId"');
    expect(sanitizer).toContain('"status"');
    expect(sanitizer).toContain('"executorAgentId"');
    expect(sanitizer).toContain('"requesterAgentId"');
    expect(sanitizer).toContain('"runId"');
    for (const sensitive of ["command", "path", "stdout", "stderr", "token"]) {
      expect(sanitizer).not.toContain(`"${sensitive}"`);
    }
    for (const route of [
      "sessions/loading.tsx",
      "sessions/[sessionId]/loading.tsx",
    ]) {
      expect(
        readFileSync(resolve(webRoot, "app/dashboard", route), "utf8"),
      ).toContain("Skeleton");
    }
  });

  it("requires an organization administrator to approve Agent registration", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const route = readFileSync(
      resolve(webRoot, "app/api/agent-device/approve/route.ts"),
      "utf8",
    );
    const approvalPage = readFileSync(
      resolve(webRoot, "app/activate-agent/page.tsx"),
      "utf8",
    );
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );

    expect(route).toContain("requireCloudAdminRouteIdentity");
    expect(approvalPage).toContain('orgRole !== "org:admin"');
    expect(server).toContain('"/v1/auth/agent/device"');
    expect(server).toContain('"/v1/agent-credentials/rotate"');
    expect(server).toContain("agent_identity_mismatch");
  });

  it("keeps autoapproval policies inactive until an administrator reviews the ceiling", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const route = readFileSync(
      resolve(webRoot, "app/api/agent-policies/approve/route.ts"),
      "utf8",
    );
    const page = readFileSync(
      resolve(webRoot, "app/policies/approve/page.tsx"),
      "utf8",
    );
    const loading = readFileSync(
      resolve(webRoot, "app/policies/approve/loading.tsx"),
      "utf8",
    );
    const form = readFileSync(
      resolve(webRoot, "components/agent-policy-approval.tsx"),
      "utf8",
    );
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );

    expect(route).toContain("requireCloudAdminRouteIdentity");
    expect(page).toContain('orgRole !== "org:admin"');
    expect(form).toContain("maxSessionSeconds");
    expect(loading).toContain("Skeleton");
    expect(server).toContain('"/v1/internal/cloud/agent-policies/approve"');
    expect(server).toContain("agent_credential_required");
  });

  it("keeps Managed Agent delegation single-level and attributable", () => {
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const sessionList = readFileSync(
      resolve(process.cwd(), "apps/web/src/components/session-list.tsx"),
      "utf8",
    );

    expect(server).toContain('"/v1/managed-agents"');
    expect(server).toContain('"/v1/agent-credentials/revoke"');
    expect(database).toContain('.where("kind", "=", "independent")');
    expect(database).toContain("managedDelegationDecision({");
    expect(database).toContain("delegationPolicyVersion");
    expect(database).toContain("requestedByAgentId");
    expect(sessionList).toContain('title="Requester"');
  });

  it("shows Session requests early without presenting identity IDs as names", () => {
    const sessionList = readFileSync(
      resolve(process.cwd(), "apps/web/src/components/session-list.tsx"),
      "utf8",
    );
    const sessionsPage = readFileSync(
      resolve(process.cwd(), "apps/web/src/app/dashboard/sessions/page.tsx"),
      "utf8",
    );
    const identity = readFileSync(
      resolve(process.cwd(), "apps/web/src/lib/clerk-identity.ts"),
      "utf8",
    );

    expect(sessionsPage).toContain("state.context.sessionRequests");
    expect(sessionList).toContain("<UserIdentityAvatar");
    expect(sessionList).toContain('?? "Member"');
    expect(sessionList).not.toContain("?? value.requestedByHumanId");
    expect(sessionList).not.toContain("?? value.requestedByAgentId");
    expect(identity).toContain("getOrganizationMembershipList");
    expect(identity).toContain("user.hasImage");
  });
});
