export function deviceLoginUrl(verificationUri: string, userCode: string): string {
  const url = new URL(verificationUri);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The Odyshell login URL must use HTTP or HTTPS");
  }
  url.searchParams.set("code", userCode);
  return url.toString();
}
