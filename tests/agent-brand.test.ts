import { describe, expect, it } from "vitest";
import { agentBrand } from "../apps/web/src/lib/agent-brand.js";

describe("Agent brand detection", () => {
  it.each([
    ["ChatGPT", "/agent-brands/chatgpt.svg"],
    ["Claude Desktop", "/agent-brands/claude.svg"],
    ["Codex", "/agent-brands/codex.svg"],
    ["Cursor", "/agent-brands/cursor.svg"],
    ["Gemini CLI", "/agent-brands/gemini.svg"],
    ["GitHub Copilot", "/agent-brands/github-copilot.svg"],
    ["Windsurf", "/agent-brands/windsurf.svg"],
  ])("maps %s to its local profile image", (name, src) => {
    expect(agentBrand(name)).toMatchObject({ src });
  });

  it("leaves custom Agent names unbranded", () => {
    expect(agentBrand("Release automation")).toBeNull();
  });
});
