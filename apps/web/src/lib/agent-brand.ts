export type AgentBrand = {
  label: string;
  src: `/agent-brands/${string}.svg`;
};

const brands: Array<AgentBrand & { patterns: RegExp[] }> = [
  {
    label: "GitHub Copilot",
    src: "/agent-brands/github-copilot.svg",
    patterns: [/\bgithub\s+copilot\b/iu, /\bcopilot\b/iu],
  },
  {
    label: "Codex",
    src: "/agent-brands/codex.svg",
    patterns: [/\bcodex\b/iu],
  },
  {
    label: "ChatGPT",
    src: "/agent-brands/chatgpt.svg",
    patterns: [/\bchat\s*gpt\b/iu, /\bopenai\b/iu],
  },
  {
    label: "Claude",
    src: "/agent-brands/claude.svg",
    patterns: [/\bclaude\b/iu, /\banthropic\b/iu],
  },
  {
    label: "Cursor",
    src: "/agent-brands/cursor.svg",
    patterns: [/\bcursor\b/iu],
  },
  {
    label: "Gemini",
    src: "/agent-brands/gemini.svg",
    patterns: [/\bgemini\b/iu],
  },
  {
    label: "Windsurf",
    src: "/agent-brands/windsurf.svg",
    patterns: [/\bwindsurf\b/iu],
  },
];

export function agentBrand(name: string): AgentBrand | null {
  const value = name.trim();
  if (!value) return null;
  const brand = brands.find(({ patterns }) =>
    patterns.some((pattern) => pattern.test(value)),
  );
  return brand ? { label: brand.label, src: brand.src } : null;
}
