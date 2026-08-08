import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsRoot = resolve(process.cwd(), "apps/web/content/docs");
const requiredPages = [
  "index.mdx",
  "quickstart.mdx",
  "concepts.mdx",
  "machines.mdx",
  "agents.mdx",
  "mcp.mdx",
  "sdk.mdx",
  "operations.mdx",
  "cli.mdx",
  "security.mdx",
  "migration.mdx",
  "event-sinks.mdx",
  "self-hosting.mdx",
  "troubleshooting.mdx",
] as const;

function documentationPages(): string[] {
  return readdirSync(docsRoot, { recursive: true })
    .filter((path): path is string => typeof path === "string")
    .filter((path) => path.endsWith(".mdx"))
    .sort();
}

describe("public documentation corpus", () => {
  it("covers the current administrator and agent workflows", () => {
    for (const page of requiredPages) {
      const path = resolve(docsRoot, page);
      expect(existsSync(path), `${page} should exist`).toBe(true);
      const content = readFileSync(path, "utf8");
      expect(content).toMatch(/^---\r?\ntitle: .+\r?\ndescription: .+\r?\n---/);
    }
  });

  it("does not publish credentials or internal planning language", () => {
    const corpus = documentationPages()
      .map((page) => readFileSync(resolve(docsRoot, page), "utf8"))
      .join("\n");

    expect(corpus).not.toMatch(
      /\bods_(?:agent|cli|enroll)_[A-Za-z0-9_-]{16,}\b/,
    );
    expect(corpus).not.toContain("dev-agent-key");
    expect(corpus).not.toContain("dev-admin-key");
    expect(corpus).not.toMatch(/\bmvp\b/iu);
    expect(corpus).not.toMatch(/\b(?:business model|roadmap)\b/iu);
  });

  it("documents Host Shell as explicit same-user authority", () => {
    const corpus = documentationPages()
      .map((page) => readFileSync(resolve(docsRoot, page), "utf8"))
      .join("\n");
    const security = readFileSync(resolve(docsRoot, "security.mdx"), "utf8");
    const eventSinks = readFileSync(
      resolve(docsRoot, "event-sinks.mdx"),
      "utf8",
    );
    const sessions = readFileSync(resolve(docsRoot, "sessions.mdx"), "utf8");
    const agents = readFileSync(resolve(docsRoot, "agents.mdx"), "utf8");
    const mcp = readFileSync(resolve(docsRoot, "mcp.mdx"), "utf8");
    const sdk = readFileSync(resolve(docsRoot, "sdk.mdx"), "utf8");
    const concepts = readFileSync(resolve(docsRoot, "concepts.mdx"), "utf8");

    expect(corpus).toContain("`host.shell`");
    expect(corpus).not.toContain("`process.shell`");
    expect(corpus).not.toContain("`sandbox.shell`");
    expect(security).toContain("operating-system user running the Client");
    expect(security).toContain("user's Home");
    expect(security).toContain("files, credentials, network, and services");
    expect(security).toContain("no sandbox or isolation");
    expect(security).toContain("persist after the Session ends");
    expect(security).toContain("standard input");
    expect(security).toContain("Event Sinks never export");
    expect(security).toContain("but no commands, paths, stdout or stderr");
    expect(eventSinks).toContain("Event Sinks never");
    expect(eventSinks).toContain("command text, stdout, stderr");
    expect(sessions).toContain(
      "Transport loss alone does not terminate an already authorized Operation",
    );
    for (const page of [agents, mcp]) {
      expect(page).toContain("exact typed Operations");
      expect(page).toContain("broad Host Shell authority");
    }
    expect(sdk).toContain("requestHostShellSession");
    expect(sdk).toContain("claimedSession(shellClaim)");
    expect(sdk).toContain("operating-system user running the Client");
    expect(sdk).toContain("user's Home");
    expect(sdk).toContain("no sandbox, PTY, persistent shell process");
    expect(sdk).toContain("missing command can fail without ending the Session");
    for (const page of [agents, concepts, sdk]) {
      expect(page).toMatch(/host\.shell[\s\S]{0,160}(?:cannot|never)[\s\S]{0,80}(?:Autoapproval|autoapproved|Delegation|delegated)/u);
    }
    expect(corpus).not.toContain("Full access");
  });

  it("distinguishes local in-process MCP reuse from persistent remote reuse", () => {
    const mcp = readFileSync(resolve(docsRoot, "mcp.mdx"), "utf8");

    expect(mcp).toContain(
      "Local `ods mcp` reuses only Sessions claimed by that same running process",
    );
    expect(mcp).toContain(
      "Remote MCP keeps its installation-bound Session grant in PostgreSQL",
    );
    expect(mcp).toContain(
      "restarting `ods mcp` requires a new Session request and approval",
    );
  });

  it("publishes the exact Host Shell CLI contract", () => {
    const cli = readFileSync(resolve(docsRoot, "cli.mdx"), "utf8");

    expect(cli).toContain(
      "`ods shell --purpose <purpose> [--title <title>] <machine> <command>`",
    );
    expect(cli).toContain("`--purpose` is required");
    expect(cli).toContain("one quoted argument");
    expect(cli).not.toContain("<command...>");
  });

  it("documents the breaking protocol v3 Profile upgrade", () => {
    const migration = readFileSync(resolve(docsRoot, "migration.mdx"), "utf8");

    expect(migration).toContain("Protocol v3 intentionally rejects protocol v2");
    expect(migration).toMatch(/remove each\s+old Profile/u);
    expect(migration).toMatch(/recreate and re-enroll/iu);
    expect(migration).toContain("`workspaceRoot`");
    expect(migration).toMatch(/operating-system\s+user's Home/u);
    expect(migration).toContain("`mountSource`");
    expect(migration).toContain("--runner docker --mount-source <absolute-path>");
  });

  it("documents the implemented self-hosted approval flow", () => {
    const selfHosting = readFileSync(resolve(docsRoot, "self-hosting.mdx"), "utf8");

    expect(selfHosting).toContain("Clerk application with Organizations enabled");
    expect(selfHosting).toContain("ODYSHELL_WEB_URL");
    expect(selfHosting).toContain("ods agent login \"My Agent\"");
    expect(selfHosting).toContain("Legacy `ods agent create`");
    expect(selfHosting).toContain("intentionally return migration errors");
    expect(selfHosting).not.toMatch(/^ods agent create\b/mu);
  });

  it("records the accepted agent-native Task and Command boundary", () => {
    const repositoryRoot = process.cwd();
    const context = readFileSync(resolve(repositoryRoot, "CONTEXT.md"), "utf8");
    const design = readFileSync(
      resolve(repositoryRoot, "docs/design/agentic-task-model.md"),
      "utf8",
    );
    const adr = readFileSync(
      resolve(
        repositoryRoot,
        "docs/adr/0008-adopt-agent-native-task-model.md",
      ),
      "utf8",
    );

    expect(context).toContain("**Task**:");
    expect(context).toContain("**Command**:");
    expect(context).not.toContain("**Workspace**:");
    expect(context).not.toContain("**Session**:");
    expect(design).toContain("one Agent");
    expect(design).toContain("one Machine and Client Profile");
    expect(design).toContain("There is no caller-supplied environment or standard input");
    expect(design).toContain("The Server is trusted");
    expect(adr).toContain("Organization, Task, and Command");
    expect(adr).toContain("No compatibility aliases or migrations");
  });

  it("documents the public CLI installation command", () => {
    for (const page of [
      "quickstart.mdx",
      "cli.mdx",
      "machines.mdx",
      "agents.mdx",
      "mcp.mdx",
      "self-hosting.mdx",
    ]) {
      const content = readFileSync(resolve(docsRoot, page), "utf8");
      expect(content).toContain("npm install --global @odyshell/cli");
      expect(content).toContain("```npm");
    }

    const sourceConfig = readFileSync(
      resolve(process.cwd(), "apps/web/source.config.ts"),
      "utf8",
    );
    expect(sourceConfig).toContain("remarkNpmOptions");
    expect(sourceConfig).toContain('id: "package-manager"');
  });

  it("builds agent-facing outputs only from the reviewed documentation source", () => {
    const webRoot = resolve(process.cwd(), "apps/web");
    const sourceConfig = readFileSync(
      resolve(webRoot, "source.config.ts"),
      "utf8",
    );
    const llmText = readFileSync(
      resolve(webRoot, "src/lib/get-llm-text.ts"),
      "utf8",
    );
    const markdownRoute = readFileSync(
      resolve(
        webRoot,
        "src/app/llms.mdx/docs/[[...slug]]/route.ts",
      ),
      "utf8",
    );
    const docsPage = readFileSync(
      resolve(webRoot, "src/app/docs/[[...slug]]/page.tsx"),
      "utf8",
    );

    expect(sourceConfig).toContain('dir: "content/docs"');
    expect(llmText).toContain('page.data.getText("processed")');
    expect(markdownRoute).toContain('"Content-Type": "text/markdown; charset=utf-8"');
    expect(markdownRoute).toContain("dynamicParams = false");
    expect(docsPage).toContain("dynamicParams = false");
    expect(markdownRoute).not.toContain("dashboard");
    expect(markdownRoute).not.toContain("cloudRequest");
  });
});
