export type UserTheme = "system" | "light" | "dark";

export function activeUserTheme(theme: string | undefined): UserTheme {
  return theme === "light" || theme === "dark" ? theme : "system";
}

export function nextUserTheme(theme: UserTheme): UserTheme {
  if (theme === "system") return "light";
  if (theme === "light") return "dark";
  return "system";
}
