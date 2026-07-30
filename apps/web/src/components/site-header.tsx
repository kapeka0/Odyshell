import { Show, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-md">
        <div className="page-shell flex h-16 items-center gap-3">
          <Brand />
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Show
              when="signed-in"
              fallback={
                <Link className={cn(buttonVariants({ size: "lg" }), "whitespace-nowrap")} href="/sign-up">
                  Start free
                </Link>
              }
            >
              <Link
                className={cn(buttonVariants({ variant: "outline", size: "lg" }), "hidden whitespace-nowrap sm:inline-flex")}
                href="/dashboard"
              >
                Dashboard
              </Link>
              <UserButton />
            </Show>
          </div>
        </div>
      </header>
    </>
  );
}
