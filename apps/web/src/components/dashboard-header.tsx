import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { QuickActions } from "@/components/quick-actions";
import { ThemeToggle } from "@/components/theme-toggle";

export function DashboardHeader() {
  return (
    <header className="border-b bg-background">
      <div className="page-shell flex min-h-16 flex-wrap items-center gap-3 py-2">
        <Brand />
        <span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
        <OrganizationSwitcher
          afterCreateOrganizationUrl="/dashboard"
          afterSelectOrganizationUrl="/dashboard"
          hidePersonal
        />
        <nav className="ml-auto flex items-center gap-2" aria-label="Workspace">
          <Link
            className="hidden whitespace-nowrap text-sm text-muted-foreground hover:text-foreground md:block"
            href="/activate"
          >
            Activate CLI
          </Link>
          <span className="hidden min-[360px]:contents">
            <QuickActions />
          </span>
          <ThemeToggle />
          <UserButton />
        </nav>
      </div>
    </header>
  );
}
