import { toFacehashHandler } from "facehash/next";
import { safeFacehashIdentity } from "@/lib/avatar";

const facehash = toFacehashHandler({
  size: 128,
  showInitial: false,
  variant: "gradient",
  cacheControl: "public, max-age=31536000, immutable",
});

export async function GET(request: Request) {
  const requestedUrl = new URL(request.url);
  const identity = safeFacehashIdentity(requestedUrl.searchParams.get("name"));
  if (!identity) {
    return Response.json({ error: "invalid_avatar_identity" }, { status: 400 });
  }
  requestedUrl.search = new URLSearchParams({
    name: identity,
    size: "128",
    showInitial: "false",
  }).toString();
  return facehash.GET(new Request(requestedUrl, request));
}
