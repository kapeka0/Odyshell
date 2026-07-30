import { Show, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { QuickActions } from "@/components/quick-actions";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur-md">
      <div className="page-shell flex h-16 items-center gap-3">
        <Brand />
        <nav aria-label="Primary" className="ml-8 hidden items-center gap-6 lg:flex">
          <Link className="whitespace-nowrap text-sm text-muted-foreground hover:text-foreground" href="/#how-it-works">
            How it works
          </Link>
          <Link className="whitespace-nowrap text-sm text-muted-foreground hover:text-foreground" href="/#security">
            Security
          </Link>
          <Link className="whitespace-nowrap text-sm text-muted-foreground hover:text-foreground" href="/#plans">
            Plans
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden min-[360px]:contents">
            <QuickActions />
          </span>
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
  );
}
