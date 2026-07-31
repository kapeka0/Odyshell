import { clerkMiddleware } from "@clerk/nextjs/server";

// Authentication and authorization live beside each protected resource.
// The proxy only makes Clerk session state available to those resources.
export default clerkMiddleware();

export const config = {
  matcher: [
    "/",
    "/activate/:path*",
    "/activate-agent/:path*",
    "/dashboard/:path*",
    "/onboarding",
    "/sign-in/:path*",
    "/sign-up/:path*",
    "/api/agent-access/:path*",
    "/api/agent-device/:path*",
    "/api/dashboard/:path*",
    "/api/device/:path*",
    "/api/enrollment-token",
    "/api/machines/:path*",
    "/__clerk/:path*",
  ],
};
