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
    "/policies/:path*",
    "/sessions/:path*",
    "/sign-in/:path*",
    "/sign-up/:path*",
    "/sso-callback/:path*",
    "/api/:path*",
    "/__clerk/:path*",
  ],
};
