export function isPublicDocumentationPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/");
}
