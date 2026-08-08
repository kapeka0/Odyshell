"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth-client";

export function SiteSessionActions() {
  const session = authClient.useSession();

  if (session.isPending) {
    return <Skeleton className="h-11 w-28" />;
  }

  if (session.data?.session) {
    return (
      <Link
        className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
        href="/dashboard"
      >
        Dashboard
      </Link>
    );
  }

  return (
    <>
      <Link
        className={cn(
          buttonVariants({ variant: "ghost", size: "lg" }),
          "hidden sm:inline-flex",
        )}
        href="/sign-in"
      >
        Sign in
      </Link>
      <Link
        className={cn(buttonVariants({ size: "lg" }))}
        href="/sign-up"
      >
        Start free
      </Link>
    </>
  );
}
