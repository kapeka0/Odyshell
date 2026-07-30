import Link from "next/link";
import { Brand } from "@/components/brand";
import { SiteSessionActions } from "@/components/site-session-actions";

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
            <Link className="text-muted-foreground transition-colors hover:text-foreground" href="/docs">
              Docs
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <SiteSessionActions />
          </div>
        </div>
      </header>
    </>
  );
}
