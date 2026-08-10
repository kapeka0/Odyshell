import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  publicSiteEnabled,
  publicSiteRequestDecision,
} from "@/lib/public-site";

export function proxy(request: NextRequest): NextResponse {
  const decision = publicSiteRequestDecision(
    publicSiteEnabled(process.env),
    request.nextUrl.pathname,
  );
  return decision === "not_found"
    ? new NextResponse(null, { status: 404 })
    : NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/).*)"],
};
