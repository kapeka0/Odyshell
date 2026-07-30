import { Show, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 pt-2">
        <div className="page-shell flex h-16 items-center gap-3 rounded-xl border bg-background/92 px-4 shadow-sm backdrop-blur-md">
          <Brand />
          <nav className="ml-8 hidden items-center gap-6 text-sm md:flex" aria-label="Main navigation">
            <Link className="text-muted-foreground transition-colors hover:text-foreground" href="/#how-it-works">
              How it works
            </Link>
            <Link className="text-muted-foreground transition-colors hover:text-foreground" href="/#plans">
              Plans
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Show
              when="signed-in"
              fallback={
                <>
                  <Link
                    className={cn(buttonVariants({ variant: "ghost", size: "lg" }), "hidden whitespace-nowrap sm:inline-flex")}
                    href="/sign-in"
                  >
                    Sign in
                  </Link>
                  <Link className={cn(buttonVariants({ size: "lg" }), "whitespace-nowrap")} href="/sign-up">
                    Start free
                  </Link>
                </>
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
