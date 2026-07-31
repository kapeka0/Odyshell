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
