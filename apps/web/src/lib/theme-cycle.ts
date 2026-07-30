export type UserTheme = "system" | "light" | "dark";

export function activeUserTheme(theme: string | undefined): UserTheme {
  return theme === "light" || theme === "dark" ? theme : "system";
}
