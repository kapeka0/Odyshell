import { readFileSync, readdirSync } from "node:fs";
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
  capabilitiesForHostShellSelection,
  capabilitiesForManualPreset,
  manualSessionSelectionIsValid,
  toggleManualHostShellSelection,
} from "../apps/web/src/lib/manual-session-access.js";
import { executionWarningState } from "../apps/web/src/lib/host-shell-access.js";
import {
  deviceApprovalErrorPath,
  deviceApprovalReason,
  deviceCodeSchema,
} from "../apps/web/src/lib/device-activation.js";
import {
  sessionApprovalRequestIdSchema,
  sessionApprovalErrorPath,
} from "../apps/web/src/lib/session-approval.js";
import { sessionApprovalUrl } from "../apps/server/src/cloud.js";
import { statusTone } from "../apps/web/src/lib/status-tone.js";

describe("web authentication boundaries", () => {
  it("keeps personal settings identity-bound and workspace settings admin-only", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const userRoute = readFileSync(resolve(webRoot, "app/api/user-settings/route.ts"), "utf8");
    const workspaceRoute = readFileSync(resolve(webRoot, "app/api/workspace-settings/route.ts"), "utf8");
    const workspacePage = readFileSync(resolve(webRoot, "app/dashboard/settings/page.tsx"), "utf8");
    const userPage = readFileSync(resolve(webRoot, "app/dashboard/user-settings/page.tsx"), "utf8");
    const skeletons = readFileSync(resolve(webRoot, "components/dashboard-skeletons.tsx"), "utf8");

    expect(userRoute).toContain("requireCloudRouteIdentity");
    expect(userRoute).not.toContain("workspaceId");
    expect(workspaceRoute).toContain("requireCloudAdminRouteIdentity");
    expect(workspaceRoute).not.toContain("workspaceId");
    expect(workspacePage).toContain("Enable Diagnostic logging?");
    expect(workspacePage).toContain('orientation="responsive"');
    expect(userPage).toContain("user.setProfileImage");
    expect(userPage).toContain("user.update");
    expect(skeletons).toContain("sections.map");
  });

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

  it("accepts only Session request IDs and builds one local review URL", () => {
    const requestId = "7d8730ef-075c-40d5-a72d-8101abe17260";
    expect(sessionApprovalRequestIdSchema.parse(requestId)).toBe(requestId);
    expect(
      sessionApprovalRequestIdSchema.safeParse(
        `https://attacker.example/${requestId}`,
      )
        .success,
    ).toBe(false);
    expect(sessionApprovalRequestIdSchema.safeParse("ods_session_secret").success)
      .toBe(false);
    expect(sessionApprovalUrl("https://odyshell.com", requestId)).toBe(
      `https://odyshell.com/sessions/approve?request=${requestId}`,
    );
    expect(sessionApprovalErrorPath(requestId)).toBe(
      "/sessions/approve/error?reason=approval_failed",
    );
    expect(sessionApprovalErrorPath(requestId)).not.toContain(requestId);
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
      expect(route).toContain("sessionApprovalRequestIdSchema");
      expect(route).not.toContain("approvalCode");
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

  it("keeps Agent brand SVGs local and free of executable content", () => {
    const assetRoot = resolve(
      process.cwd(),
      "apps/web/public/agent-brands",
    );
    const assets = readdirSync(assetRoot)
      .filter((file) => file.endsWith(".svg"))
      .toSorted();

    expect(assets).toEqual([
      "chatgpt.svg",
      "claude.svg",
      "codex.svg",
      "cursor.svg",
      "gemini.svg",
      "github-copilot.svg",
      "windsurf.svg",
    ]);
    for (const asset of assets) {
      const svg = readFileSync(resolve(assetRoot, asset), "utf8");
      const content = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");
      expect(svg).toContain("viewBox=");
      expect(content).not.toMatch(/https?:\/\//iu);
      expect(svg).not.toMatch(/<script|<foreignObject|javascript:|\bon\w+=/iu);
      expect(svg).not.toMatch(/\b(?:href|xlink:href)=["'](?!#)/iu);
    }
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
    expect(command).not.toContain("--workspace");
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
    const enabled = toggleReadOnlyPreset(["fs.write", "host.shell"]);
    expect(enabled).toEqual(readOnlyCapabilities);
    expect(isReadOnlyPreset(enabled)).toBe(true);
    expect(toggleReadOnlyPreset(enabled)).toEqual([]);
    expect(isReadOnlyPreset(["fs.read"])).toBe(false);
  });

  it("keeps Host Shell separate from every structured access preset", () => {
    const locallyAllowed = [
      "process.exec",
      "host.shell",
      "fs.stat",
      "fs.list",
      "fs.search",
      "fs.read",
      "fs.write",
      "fs.mkdir",
      "fs.remove",
      "docker.logs",
    ] as const;

    expect(capabilitiesForManualPreset("read-only", locallyAllowed)).toEqual([
      "fs.stat",
      "fs.list",
      "fs.search",
      "fs.read",
    ]);
    expect(capabilitiesForHostShellSelection(locallyAllowed)).toEqual([
      "host.shell",
    ]);
  });

  it("cannot grant Host Shell beyond the machine Local Policy", () => {
    expect(capabilitiesForHostShellSelection(["fs.read"])).toEqual([]);
    expect(
      manualSessionSelectionIsValid(
        ["host.shell", "fs.read"],
        ["fs.read"],
      ),
    ).toBe(false);
    expect(
      manualSessionSelectionIsValid(["fs.read"], ["fs.read"]),
    ).toBe(true);
  });

  it("does not retain implicit Read-only authority when Host Shell is selected", () => {
    const locallyAllowed = [
      "host.shell",
      "fs.stat",
      "fs.list",
      "fs.search",
      "fs.read",
    ] as const;
    const readOnly = capabilitiesForManualPreset("read-only", locallyAllowed);

    expect(
      toggleManualHostShellSelection(readOnly, locallyAllowed, "read-only"),
    ).toEqual(["host.shell"]);
    expect(
      toggleManualHostShellSelection(["fs.read"], locallyAllowed, null),
    ).toEqual(["fs.read", "host.shell"]);
    expect(
      toggleManualHostShellSelection(
        ["fs.read", "host.shell"],
        locallyAllowed,
        null,
      ),
    ).toEqual(["fs.read"]);
  });

  it("keeps the Host Shell warning independent from the additive sudo warning", () => {
    expect(executionWarningState([], "none")).toEqual({
      hostShell: false,
      rootAccess: false,
    });
    expect(executionWarningState(["host.shell"], "none")).toEqual({
      hostShell: true,
      rootAccess: false,
    });
    expect(executionWarningState(["process.exec"], "sudo")).toEqual({
      hostShell: false,
      rootAccess: true,
    });
    expect(executionWarningState(["host.shell"], "sudo")).toEqual({
      hostShell: true,
      rootAccess: true,
    });
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
    const agentList = readFileSync(
      resolve(process.cwd(), "apps/web/src/components/agent-list.tsx"),
      "utf8",
    );
    expect(selectDisplayLabel("Dates", [], "all")).toBe("All Dates");
    expect(selectDisplayLabel("Statuses", [], "all")).toBe("All Statuses");
    expect(
      selectDisplayLabel(
        "Dates",
        [{ label: "Last 7 days", value: "7d" }],
        "7d",
      ),
    ).toBe("Last 7 days");
    expect(dataTable).toContain("selectDisplayLabel(");
    expect(dataTable).not.toContain("<SelectValue />");
    expect(agentList).toContain('label: "Types"');
    expect(agentList).toContain('label: "Statuses"');
    expect(agentList).not.toMatch(/label:\s*"All /u);
  });

  it("maps Select values to user-facing labels instead of internal identifiers", () => {
    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    const sessionForm = readFileSync(
      resolve(componentsRoot, "create-session-sheet.tsx"),
      "utf8",
    );
    const eventSink = readFileSync(
      resolve(componentsRoot, "event-sink-settings.tsx"),
      "utf8",
    );
    const dataTable = readFileSync(
      resolve(componentsRoot, "data-table.tsx"),
      "utf8",
    );

    for (const items of ["agentOptions", "machineOptions", "durations"]) {
      expect(sessionForm).toContain(`items={${items}}`);
    }
    expect(sessionForm).toContain('{ value: "300", label: "5 minutes" }');
    expect(sessionForm).toContain('{ value: "900", label: "15 minutes" }');
    expect(eventSink).toContain("items={detailLevels}");
    expect(dataTable).toContain("items={filterOptions}");
  });

  it("keeps manual Session creation capability-based and in the table toolbar", () => {
    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    const sessionForm = readFileSync(
      resolve(componentsRoot, "create-session-sheet.tsx"),
      "utf8",
    );
    const sessionList = readFileSync(
      resolve(componentsRoot, "session-list.tsx"),
      "utf8",
    );
    const sessionsPage = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/src/app/dashboard/sessions/page.tsx",
      ),
      "utf8",
    );
    const sessionsLoading = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/src/app/dashboard/sessions/loading.tsx",
      ),
      "utf8",
    );
    const enrollment = readFileSync(
      resolve(componentsRoot, "enroll-machine.tsx"),
      "utf8",
    );
    const machineList = readFileSync(
      resolve(componentsRoot, "machine-list.tsx"),
      "utf8",
    );
    const approval = readFileSync(
      resolve(componentsRoot, "session-approval.tsx"),
      "utf8",
    );
    const hostShellWarning = readFileSync(
      resolve(componentsRoot, "host-shell-warning.tsx"),
      "utf8",
    );
    const accessOptions = readFileSync(
      resolve(process.cwd(), "apps/web/src/lib/agent-access-options.ts"),
      "utf8",
    );
    const manualAccess = readFileSync(
      resolve(process.cwd(), "apps/web/src/lib/manual-session-access.ts"),
      "utf8",
    );
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );

    expect(sessionForm).not.toContain("session-path");
    expect(sessionForm).not.toContain("session-container");
    expect(sessionForm).not.toContain("restrictions.filesystem");
    expect(sessionForm).not.toContain("restrictions.docker");
    expect(sessionForm).not.toContain("session-program");
    expect(sessionForm).not.toContain("session-args");
    expect(sessionForm).not.toContain("splitArguments");
    expect(sessionForm).toContain('value="host-shell"');
    expect(sessionForm).toContain("Host Shell");
    expect(sessionForm.match(/Host Shell/gu) ?? []).toHaveLength(1);
    expect(sessionForm).not.toContain("Full access");
    expect(enrollment).not.toContain("Full access");
    for (const surface of [
      sessionForm,
      enrollment,
      machineList,
      approval,
      accessOptions,
      manualAccess,
    ]) {
      expect(surface).not.toContain("process.shell");
      expect(surface).not.toContain("Full access");
    }
    for (const surface of [sessionForm, enrollment, machineList, approval]) {
      expect(surface).toContain("HostShellWarning");
    }
    expect(machineList).toContain("executionWarningState");
    expect(machineList).toContain("Root access possible");
    expect(hostShellWarning).toContain("operating-system user running the Client");
    expect(hostShellWarning).toContain("user's Home");
    expect(hostShellWarning).toContain("files, credentials, network, and services");
    expect(hostShellWarning).toContain("no sandbox or isolation");
    expect(hostShellWarning).toContain("persist after the Session ends");
    expect(approval).toContain('<ApprovalRow label="Task"');
    expect(approval).toContain('label="Replaces"');
    expect(approval).not.toContain('label="Renews"');
    const inspection = server.slice(
      server.indexOf('"/v1/internal/cloud/session-requests/inspect"'),
      server.indexOf('"/v1/internal/cloud/session-requests/approve"'),
    );
    expect(inspection).toContain("title: sessionRequest.title");
    expect(sessionForm).toContain("agent?.credentialActive");
    expect(sessionForm).toContain("machine?.online");
    expect(sessionForm).toContain("selectionIsValid");
    expect(sessionList).toContain("toolbarAction={<CreateSessionSheet />}");
    expect(sessionsPage).not.toContain("action={<CreateSessionSheet />}");
    expect(sessionsLoading).toContain("toolbarAction");
  });

  it("edits machine metadata without widening the Client Local Policy", () => {
    const root = process.cwd();
    const machineList = readFileSync(
      resolve(root, "apps/web/src/components/machine-list.tsx"),
      "utf8",
    );
    const machineRoute = readFileSync(
      resolve(root, "apps/web/src/app/api/machines/[machineId]/route.ts"),
      "utf8",
    );
    expect(machineList).toContain("Edit machine");
    expect(machineList).toContain("machine.availableCapabilities.includes");
    expect(machineList).toContain("maxLength={280}");
    expect(machineRoute).toContain("export async function PATCH");
    expect(machineRoute).toContain("requireCloudRouteIdentity()");
  });

  it("keeps collection creation actions in table toolbars with stable labels", () => {
    const root = process.cwd();
    const machinePage = readFileSync(
      resolve(root, "apps/web/src/app/dashboard/machines/page.tsx"),
      "utf8",
    );
    const machineList = readFileSync(
      resolve(root, "apps/web/src/components/machine-list.tsx"),
      "utf8",
    );
    const loading = readFileSync(
      resolve(root, "apps/web/src/app/dashboard/machines/loading.tsx"),
      "utf8",
    );
    expect(machinePage).toContain('<DashboardPageHeader title="Machines" />');
    expect(machineList).toContain("toolbarAction={");
    expect(machineList).toContain("Machine limit reached");
    expect(machineList).not.toContain(">Machine limit reached</Button>");
    expect(loading).toContain("toolbarAction");
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
    expect(userSettings).toContain("<Card");
    expect(userSettings).toContain('orientation="responsive"');
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
    const tokens = readFileSync(
      resolve(process.cwd(), "apps/web/tokens.css"),
      "utf8",
    );
    expect(tokens).toContain("--color-rule-strong: oklch(0.7 0 0)");
    expect(tokens).toContain("--color-rule-strong: oklch(0.38 0 0)");
  });

  it("makes the selected sidebar link distinct from hover", () => {
    const webRoot = resolve(process.cwd(), "apps/web");
    const sidebarNav = readFileSync(
      resolve(webRoot, "src/components/sidebar-nav.tsx"),
      "utf8",
    );
    const styles = readFileSync(
      resolve(webRoot, "src/app/globals.css"),
      "utf8",
    );

    expect(sidebarNav).toContain("--sidebar-active");
    expect(sidebarNav).toContain("--sidebar-active-border");
    expect(styles).toContain("--sidebar-active: oklch(0.945 0 0)");
    expect(styles).toContain("--sidebar-active: oklch(0.22 0 0)");
  });

  it("keeps every text area fixed to its surrounding layout", () => {
    const webRoot = resolve(process.cwd(), "apps/web");
    const styles = readFileSync(
      resolve(webRoot, "src/app/globals.css"),
      "utf8",
    );
    const interfaceRules = readFileSync(
      resolve(webRoot, "UI_RULES.md"),
      "utf8",
    );

    expect(styles).toMatch(/textarea\s*\{\s*resize:\s*none;/u);
    expect(interfaceRules).toMatch(
      /never expose browser resize\s+handles/u,
    );
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

  it("keeps machine and Session IDs in details instead of collection rows", () => {
    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    const machineList = readFileSync(
      resolve(componentsRoot, "machine-list.tsx"),
      "utf8",
    );
    const sessionList = readFileSync(
      resolve(componentsRoot, "session-list.tsx"),
      "utf8",
    );
    const sessionDetail = readFileSync(
      resolve(componentsRoot, "session-detail.tsx"),
      "utf8",
    );
    const machineRow = machineList.slice(
      machineList.indexOf('accessorKey: "name"'),
      machineList.indexOf('id: "platform"'),
    );
    const machineDetails = machineList.slice(
      machineList.indexOf("<Dialog open={detailsOpen}"),
      machineList.indexOf("<Dialog open={editOpen}"),
    );
    const sessionRow = sessionList.slice(
      sessionList.indexOf('id: "title"'),
      sessionList.indexOf('id: "machine"'),
    );

    expect(machineRow).not.toContain("<CopyableValue");
    expect(machineDetails).toContain('label="Machine ID"');
    expect(sessionRow).not.toContain("<CopyableValue");
    expect(sessionRow).toContain("row.original.value.purpose");
    expect(sessionRow).toContain("truncate text-xs text-muted-foreground");
    expect(sessionDetail).toContain('label="Session ID"');
    expect(sessionDetail).toContain("initial.session.id");
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
    const cancelAction = machineForm.search(/>\s*Cancel\s*<\/Link>/u);
    const addAction = machineForm.search(/\sAdd\s*<\/Button>/u);
    expect(cancelAction).toBeGreaterThan(-1);
    expect(addAction).toBeGreaterThan(cancelAction);
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

  it("keeps Settings cards quiet, descriptive and documentation-linked", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const workspaceSettings = readFileSync(
      resolve(webRoot, "app/dashboard/settings/page.tsx"),
      "utf8",
    );
    const userSettings = readFileSync(
      resolve(webRoot, "app/dashboard/user-settings/page.tsx"),
      "utf8",
    );
    const skeletons = readFileSync(
      resolve(webRoot, "components/dashboard-skeletons.tsx"),
      "utf8",
    );
    const onboarding = readFileSync(
      resolve(webRoot, "components/workspace-onboarding.tsx"),
      "utf8",
    );

    for (const settings of [workspaceSettings, userSettings]) {
      expect(settings).not.toContain('className="border-b p-4"');
      expect(settings).toContain('border-0 bg-card');
      expect(settings).toContain("<FieldDescription>");
    }
    expect(workspaceSettings).toContain('href="/docs/sessions#timeline"');
    expect(skeletons).not.toContain('gap-6 border-b p-4');
    expect(onboarding).toContain("suggestedWorkspaceName(user?.firstName)");
    expect(onboarding).toContain("'s\"} Workspace");
  });

  it("loads page-view analytics once from the global Next.js boundary", () => {
    const rootLayout = readFileSync(
      resolve(process.cwd(), "apps/web/src/app/layout.tsx"),
      "utf8",
    );
    const webManifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "apps/web/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(rootLayout).toContain(
      'import { Analytics } from "@vercel/analytics/next"',
    );
    expect(rootLayout.match(/<Analytics \/>/gu)).toHaveLength(1);
    expect(rootLayout).not.toContain("beforeSend=");
    expect(rootLayout).not.toContain("track(");
    expect(webManifest.dependencies?.["@vercel/analytics"]).toBe("^2.0.1");
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
    const sessionList = readFileSync(
      resolve(webRoot, "components/session-list.tsx"),
      "utf8",
    );
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );
    const eventSinks = readFileSync(
      resolve(process.cwd(), "apps/server/src/event-sinks.ts"),
      "utf8",
    );
    const sanitizer = eventSinks.slice(
      eventSinks.indexOf("const minimalKeys"),
      eventSinks.indexOf("const eventSinkMinimalKeys"),
    );

    expect(canvas).toContain("context.agents");
    expect(canvas).toContain('type: "session"');
    expect(canvas).toContain("session.targets.map");
    expect(sidebar).toContain('href: "/dashboard/sessions"');
    expect(sessionList).toContain("request.approvalUrl");
    expect(sessionList).toContain("Review");
    expect(server).toContain(
      "approvalUrl: sessionApprovalUrl(webUrl, sessionRequest.id)",
    );
    expect(sanitizer).toContain('"machineId"');
    expect(sanitizer).toContain('"status"');
    expect(sanitizer).toContain('"executorAgentId"');
    expect(sanitizer).toContain('"requesterAgentId"');
    expect(sanitizer).toContain('"actorHumanId"');
    expect(sanitizer).toContain('"actorAgentId"');
    expect(sanitizer).toContain('"outcome"');
    expect(sanitizer).not.toContain('"summary"');
    expect(sanitizer).toContain('"runId"');
    expect(sanitizer).toContain('"exitCode"');
    for (const sensitive of ["stdout", "stderr", "token", "command", "path"]) {
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

  it("keeps persistent Agent deletion behind the organization administrator boundary", () => {
    const route = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/src/app/api/agents/[agentId]/route.ts",
      ),
      "utf8",
    );
    const list = readFileSync(
      resolve(process.cwd(), "apps/web/src/components/agent-list.tsx"),
      "utf8",
    );

    expect(route).toContain("requireCloudAdminRouteIdentity");
    expect(route).toContain("agentIdSchema.safeParse");
    expect(list).not.toContain("currentMemberRole");
    expect(list).toContain("canDelete");
    expect(list).toContain("Credentials and active Sessions");
  });

  it("renders durable member notifications in a minimal shadcn Sheet", () => {
    const notifications = readFileSync(
      resolve(process.cwd(), "apps/web/src/components/notifications-sheet.tsx"),
      "utf8",
    );

    expect(notifications).toContain("<Sheet");
    expect(notifications).toContain("BellIcon");
    expect(notifications).toContain("motion-safe:animate-ping");
    expect(notifications).toContain("Mark all");
    expect(notifications).toContain("/api/notifications/read-all");
    expect(notifications).toContain("optimisticallyUpdate");
    expect(notifications).toContain("previousReadAt");
    expect(notifications).not.toContain("await setRead(notification, true)");
    expect(
      notifications.indexOf(
        "updateReadState(new Map([[notification.id, nextReadAt]]))",
      ),
    ).toBeLessThan(
      notifications.indexOf(
        "await fetch(`/api/notifications/${notification.id}/read`",
      ),
    );
    expect(notifications).not.toContain("stdout");
    expect(notifications).not.toContain("stderr");
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
    const proposalSchema = server.slice(
      server.indexOf("const agentPolicyProposalSchema"),
      server.indexOf("const cloudAgentPolicySchema"),
    );
    expect(proposalSchema).toContain('scope.capabilities.includes("host.shell")');
    expect(proposalSchema).toContain(
      "Host Shell cannot be included in autoapproval or delegation policies",
    );
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
    expect(sessionList).toContain("<AgentIdentityAvatar");
    expect(sessionList).toContain("value.requestedByAgentId");
    expect(sessionList).toContain('title="Machine"');
    expect(sessionList).toContain('?? "Member"');
    expect(sessionList).not.toContain("?? value.requestedByHumanId");
    expect(sessionList).not.toContain("?? value.requestedByAgentId");
    expect(identity).toContain("getOrganizationMembershipList");
    expect(identity).toContain("user.hasImage");
    expect(identity).toContain('return [];');
  });

  it("renders recognizable Agent and Activity identities", () => {
    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    const agentList = readFileSync(
      resolve(componentsRoot, "agent-list.tsx"),
      "utf8",
    );
    const canvas = readFileSync(
      resolve(componentsRoot, "workspace-canvas.tsx"),
      "utf8",
    );
    const activity = readFileSync(
      resolve(componentsRoot, "control-event-list.tsx"),
      "utf8",
    );
    const activityPage = readFileSync(
      resolve(
        process.cwd(),
        "apps/web/src/app/dashboard/activity/page.tsx",
      ),
      "utf8",
    );

    expect(agentList).toContain("<AgentIdentityAvatar");
    expect(canvas).toContain("<AgentIdentityAvatar");
    expect(activity).toContain("<UserIdentityAvatar");
    expect(activity).toContain("<AgentIdentityAvatar");
    expect(activityPage).toContain("members={state.context.members}");
  });

  it("shows Session duration and a single Agents result count", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const sessionList = readFileSync(
      resolve(webRoot, "components/session-list.tsx"),
      "utf8",
    );
    const agentList = readFileSync(
      resolve(webRoot, "components/agent-list.tsx"),
      "utf8",
    );
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );

    expect(sessionList).toContain('title="Duration"');
    expect(sessionList).toContain("formatSessionDuration(");
    expect(sessionList).toContain("row.value.readyAt ?? row.value.createdAt");
    expect(server).toContain("readyAt: isoTimestamp(session.readyAt)");
    expect(server).toContain("durationSeconds: sessionRequest.durationSeconds");
    expect(agentList).not.toContain("summaryLabel=");
  });

  it("shows when each Agent was created", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const agentList = readFileSync(
      resolve(webRoot, "components/agent-list.tsx"),
      "utf8",
    );
    const agentLoading = readFileSync(
      resolve(webRoot, "app/dashboard/agents/loading.tsx"),
      "utf8",
    );
    const cloudApi = readFileSync(resolve(webRoot, "lib/cloud-api.ts"), "utf8");
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );

    expect(agentList).toContain('accessorKey: "createdAt"');
    expect(agentList).toContain('title="Created"');
    expect(agentList).toContain('dateTime={row.original.createdAt}');
    expect(agentLoading).toContain("columns={6}");
    expect(cloudApi).toContain("export type CloudAgent = {");
    expect(cloudApi).toContain("createdAt: string;");
    expect(server).toContain("createdAt: isoTimestamp(agent.createdAt)");
  });

  it("shows locally enabled sudo before a process Session is approved", () => {
    const webRoot = resolve(process.cwd(), "apps/web/src");
    const machineList = readFileSync(
      resolve(webRoot, "components/machine-list.tsx"),
      "utf8",
    );
    const createSession = readFileSync(
      resolve(webRoot, "components/create-session-sheet.tsx"),
      "utf8",
    );
    const approval = readFileSync(
      resolve(webRoot, "components/session-approval.tsx"),
      "utf8",
    );
    const server = readFileSync(
      resolve(process.cwd(), "apps/server/src/index.ts"),
      "utf8",
    );

    expect(machineList).toContain('label="Sudo"');
    expect(machineList).toContain("machinePrivilegeEscalation(machine.runtime)");
    expect(createSession).toContain("Root access possible");
    expect(approval).toContain("rootAccessPossible");
    expect(approval).toContain("passwordless sudo");
    expect(server).toContain(
      "privilegeEscalation: machinePrivilegeEscalation(machine?.runtime)",
    );
  });
});
