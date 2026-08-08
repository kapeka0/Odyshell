export function safeAuthRedirect(
  value: string | string[] | undefined,
  fallback = "/dashboard",
): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    return fallback;
  }

  try {
    const parsed = new URL(value, "https://odyshell.com");
    if (parsed.origin !== "https://odyshell.com") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
