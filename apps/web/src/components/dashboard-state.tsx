import { KeyRoundIcon, ServerOffIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { DashboardState } from "@/lib/dashboard-context";

export function DashboardStateNotice({
  state,
}: {
  state: Exclude<DashboardState, { status: "ready" }>;
}) {
  if (state.status === "organization-required") {
    return (
      <Alert>
        <KeyRoundIcon />
        <AlertTitle>Select an organization</AlertTitle>
        <AlertDescription>
          Choose or create an organization from the sidebar to continue.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <ServerOffIcon />
      <AlertTitle>Odyshell is unavailable</AlertTitle>
      <AlertDescription>
        {state.message}. Check the server configuration and try again.
      </AlertDescription>
    </Alert>
  );
}

export function DashboardPageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-sm text-muted-foreground">{eyebrow}</p>
        ) : null}
        <h1
          className={
            eyebrow
              ? "mt-1 text-3xl font-semibold tracking-[-0.03em]"
              : "text-3xl font-semibold tracking-[-0.03em]"
          }
        >
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </header>
  );
}

export function DashboardPage({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 md:px-8 md:py-12">
      {children}
    </div>
  );
}
