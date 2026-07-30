export function vercelAvatarUrl(identity: string, initials: string): string {
  const url = new URL(
    `${encodeURIComponent(identity)}.svg`,
    "https://avatar.vercel.sh/",
  );
  url.searchParams.set("text", initials.slice(0, 2).toUpperCase());
  url.searchParams.set("size", "64");
  return url.toString();
}
