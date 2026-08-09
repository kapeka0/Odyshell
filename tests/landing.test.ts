import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const web = resolve(root, "apps/web");
const source = (path: string) => readFileSync(resolve(web, path), "utf8");

describe("agent-native landing", () => {
  it("leads with temporary Agent access, traceability, and Human supervision", () => {
    const page = source("src/app/page.tsx");

    expect(page).toContain("Let agents work.");
    expect(page).toContain("Temporary, approved shell Sessions");
    expect(page).toContain("A Human approves in the browser");
    expect(page).toContain("See exactly what happened.");
  });

  it("does not advertise removed or unvalidated product surfaces", () => {
    const page = source("src/app/page.tsx");

    for (const obsolete of [
      "Create a workspace",
      "TypeScript SDK",
      "structured operation",
      "All operation capabilities",
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

    expect(rules).toContain("Standard Agents require");
    expect(rules).toContain("$30/member/month Pro");
    expect(design).toContain("Manrope for landing");
    expect(design).toContain("supplied product references");
  });
});
