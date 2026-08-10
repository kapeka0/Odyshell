import Link from "next/link";
import { Brand } from "@/components/brand";
import { SiteSessionActions } from "@/components/site-session-actions";
import { buttonVariants } from "@/components/ui/button";

export function SiteHeader() {
  const publicSite = process.env.ODYSHELL_PUBLIC_SITE === "true";
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-md">
        <div className="landing-shell flex h-[4.5rem] items-center gap-3">
          <Brand />
          <nav className="ml-8 hidden items-center gap-6 text-sm md:flex" aria-label="Main navigation">
            <Link className="text-muted-foreground transition-colors hover:text-foreground" href="/#product">
              Product
            </Link>
            <Link className="text-muted-foreground transition-colors hover:text-foreground" href="/#security">
              Security
            </Link>
            <Link className="text-muted-foreground transition-colors hover:text-foreground" href="/#self-hosting">
              Self-hosting
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {publicSite ? (
              <a className={buttonVariants({ size: "lg" })} href="https://github.com/kapeka0/odyshell">
                Deploy Odyshell
              </a>
            ) : (
              <SiteSessionActions />
            )}
          </div>
        </div>
      </header>
    </>
  );
}
