export function facehashAvatarPath(identity: string): string {
  const search = new URLSearchParams({
    name: identity,
    size: "128",
    showInitial: "false",
  });
  return `/api/avatar?${search.toString()}`;
}

export function safeFacehashIdentity(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{1,256}$/u.test(value) ? value : null;
}
