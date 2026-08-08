import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const web = resolve(root, "apps/web");
const source = (path: string) => readFileSync(resolve(web, path), "utf8");

describe("agent-native landing", () => {
  it("leads with Agents, real Machines, and optional Human supervision", () => {
    const page = source("src/app/page.tsx");

    expect(page).toContain("The control plane for agents on real machines.");
    expect(page).toContain("remote MCP or canonical HTTP");
    expect(page).toContain("Optional supervision");
    expect(page).toContain("Humans observe, approve exceptions and audit work");
    expect(page).toContain("Cloud and self-hosted deployments use the same Server");
  });

  it("does not advertise removed or unvalidated product surfaces", () => {
    const page = source("src/app/page.tsx");

    for (const obsolete of [
      "Create a workspace",
      "macOS",
      "Windows",
      "TypeScript SDK",
      "structured operation",
      "All operation capabilities",
      "Pricing",
      "Plans",
      "MVP",
    ]) {
      expect(page).not.toContain(obsolete);
    }
  });

  it("keeps the landing mostly server-rendered and removes obsolete animated previews", () => {
    const page = source("src/app/page.tsx");
    const trace = source("src/components/agent-command-trace.tsx");

    expect(page).not.toContain('"use client"');
    expect(trace).not.toContain('"use client"');
    expect(page).not.toContain("motion/react");
    expect(page).toContain('variable: "--font-marketing"');
    expect(source("src/app/globals.css")).toContain(
      "--font-display-family: var(--font-marketing)",
    );
    expect(existsSync(resolve(web, "src/components/product-preview.tsx"))).toBe(false);
    expect(existsSync(resolve(web, "src/components/reveal.tsx"))).toBe(false);
  });

  it("records the public visual and product direction", () => {
    const rules = source("UI_RULES.md");
    const design = source("design.md");

    expect(rules).toContain("Agents are the primary");
    expect(rules).toContain("Do not publish unvalidated pricing");
    expect(design).toContain("Use Manrope for public landing");
    expect(design).toContain("24-pixel gutters");
  });
});
