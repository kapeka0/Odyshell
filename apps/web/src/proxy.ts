import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { publicSiteRequestDecision } from "@/lib/public-site";

export function proxy(request: NextRequest): NextResponse {
  const decision = publicSiteRequestDecision(
    process.env.ODYSHELL_PUBLIC_SITE === "true",
    request.nextUrl.pathname,
  );
  return decision === "not_found"
    ? new NextResponse(null, { status: 404 })
    : NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/sign-in/:path*",
    "/sign-up/:path*",
    "/onboarding/:path*",
    "/oauth/:path*",
    "/api/:path*",
    "/.well-known/:path*",
  ],
};
