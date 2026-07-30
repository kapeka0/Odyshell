import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { safeAuthRedirect } from "../apps/web/src/lib/auth-redirect.js";
import {
  facehashAvatarPath,
  safeFacehashIdentity,
  vercelAvatarUrl,
} from "../apps/web/src/lib/avatar.js";
import {
  machineEnrollmentCommand,
  posixShellArgument,
} from "../apps/web/src/lib/enrollment-command.js";
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

describe("web authentication boundaries", () => {
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
      capabilities: ["fs.read"],
    });

    expect(command).toContain(
      "--server 'https://self-hosted.example/api?mode=one&next=ignored'",
    );
    expect(posixShellArgument("value'with-quote")).toBe(
      "'value'\"'\"'with-quote'",
    );
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

  it("keeps loading feedback in forms and toast notifications above dialogs", () => {
    const componentsRoot = resolve(
      process.cwd(),
      "apps/web/src/components",
    );
    for (const file of [
      "agent-access-manager.tsx",
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
    ).toContain("whitespace-pre-wrap break-all");
    expect(
      readFileSync(resolve(componentsRoot, "app-shell.tsx"), "utf8"),
    ).toContain('className="mx-0.5 h-4! w-px! self-center!"');
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
    expect(userMenu).not.toContain("User settings");
    expect(userMenu).toContain("nextUserTheme(activeTheme)");
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
    for (const file of [
      "machine-list.tsx",
      "agent-access-manager.tsx",
      "control-event-list.tsx",
    ]) {
      expect(
        readFileSync(resolve(componentsRoot, file), "utf8"),
      ).toContain("<CopyableValue");
    }
  });

  it("uses route-specific skeletons and theme-aware browser icons", () => {
    const dashboardRoot = resolve(
      process.cwd(),
      "apps/web/src/app/dashboard",
    );
    for (const route of [
      "machines/loading.tsx",
      "machines/add/loading.tsx",
      "agents/loading.tsx",
      "activity/loading.tsx",
      "settings/loading.tsx",
      "user-settings/loading.tsx",
    ]) {
      expect(
        readFileSync(resolve(dashboardRoot, route), "utf8"),
      ).toContain("Skeleton");
    }
    const rootLayout = readFileSync(
      resolve(process.cwd(), "apps/web/src/app/layout.tsx"),
      "utf8",
    );
    expect(rootLayout).toContain("prefers-color-scheme: light");
    expect(rootLayout).toContain("prefers-color-scheme: dark");
    expect(rootLayout).toContain("odyshell-square-light.svg");
    expect(rootLayout).toContain("odyshell-square-dark.svg");
  });
});
