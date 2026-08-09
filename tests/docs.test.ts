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
  "tasks.mdx",
  "commands.mdx",
  "settings.mdx",
  "mcp.mdx",
  "cli.mdx",
  "security.mdx",
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

  it("documents same-user shell authority and durable audit boundaries", () => {
    const corpus = documentationPages()
      .map((page) => readFileSync(resolve(docsRoot, page), "utf8"))
      .join("\n");
    const security = readFileSync(resolve(docsRoot, "security.mdx"), "utf8");
    const agents = readFileSync(resolve(docsRoot, "agents.mdx"), "utf8");
    const commands = readFileSync(resolve(docsRoot, "commands.mdx"), "utf8");
    const concepts = readFileSync(resolve(docsRoot, "concepts.mdx"), "utf8");

    expect(security).toContain("same-user shell authority");
    expect(security).toContain("operating-system user");
    expect(security).toMatch(/user's files\s+and credentials/u);
    expect(security).toContain("does not configure sudo");
    expect(security).toContain("stdout, and stderr are excluded");
    expect(agents).toContain("same-user authority");
    expect(agents).toContain("arbitrary non-interactive shell Commands");
    expect(commands).toContain("PTYs, and persistent shell state are not");
    expect(commands).toContain("never stores OAuth credentials or retained stdout/stderr");
    expect(concepts).toContain("The Server can grant less but never");
    expect(corpus).not.toContain("Full access");
  });

  it("documents only the canonical remote Task and Command MCP", () => {
    const mcp = readFileSync(resolve(docsRoot, "mcp.mdx"), "utf8");

    expect(mcp).toContain("`task_request`");
    expect(mcp).toContain("`command_run`");
    expect(mcp).toContain("OAuth");
    expect(mcp).not.toContain("`ods mcp`");
    expect(mcp).not.toContain("Session Credential");
  });

  it("publishes a Machine-only Linux CLI contract", () => {
    const cli = readFileSync(resolve(docsRoot, "cli.mdx"), "utf8");

    expect(cli).toContain("Linux and Node.js 24");
    expect(cli).toContain("`ods` is a Machine administration tool");
    expect(cli).toContain("ods client doctor --profile default");
    expect(cli).toContain("no Human login, Agent runtime, Task, Command");
    expect(cli).not.toContain("ods login");
    expect(cli).not.toContain("ods exec");
    expect(cli).not.toContain("ods shell");
  });

  it("does not publish compatibility or legacy runtime guides", () => {
    for (const page of [
      "sessions.mdx",
      "operations.mdx",
      "sdk.mdx",
      "migration.mdx",
      "event-sinks.mdx",
    ]) {
      expect(existsSync(resolve(docsRoot, page))).toBe(false);
    }
  });

  it("documents the implemented self-hosted approval flow", () => {
    const selfHosting = readFileSync(resolve(docsRoot, "self-hosting.mdx"), "utf8");

    expect(selfHosting).toContain("BETTER_AUTH_SECRET");
    expect(selfHosting).toContain("ODYSHELL_WEB_KEY");
    expect(selfHosting).toContain("Server's `/mcp` resource");
    expect(selfHosting).not.toContain("--agent-id");
    expect(selfHosting).not.toContain("ods agent login");
    expect(selfHosting).not.toContain("ods exec");
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
    const machineBindingAdr = readFileSync(
      resolve(
        repositoryRoot,
        "docs/adr/0009-bind-agents-to-machines-only-through-tasks.md",
      ),
      "utf8",
    );

    expect(context).toContain("**Task**:");
    expect(context).toContain("**Command**:");
    expect(context).not.toContain("**Workspace**:");
    expect(context).not.toContain("**Session**:");
    expect(design).toContain("one Agent");
    expect(design).toContain("one Machine and Client Profile");
    expect(machineBindingAdr).toContain("A Machine belongs to one Organization, never to an Agent");
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
