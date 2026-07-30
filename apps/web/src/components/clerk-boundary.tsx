"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { isPublicDocumentationPath } from "@/lib/public-documentation";

export function ClerkBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (isPublicDocumentationPath(pathname)) return children;

  return (
    <ClerkProvider
      dynamic
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
      taskUrls={{ "choose-organization": "/onboarding" }}
    >
      {children}
    </ClerkProvider>
  );
}
