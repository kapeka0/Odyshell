import { CheckCircle2Icon } from "lucide-react";
import Link from "next/link";
import { ActivationShell } from "@/components/activation-shell";
import { CopyableValue } from "@/components/copyable-value";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const odyshellSkillInstallCommand =
  "npx skills add kapeka0/Odyshell --skill odyshell";

export default function ActivationSuccessPage() {
  return (
    <ActivationShell
      title="CLI connected"
      description="The login request was approved successfully."
    >
      <div className="flex flex-col gap-5">
        <Alert>
          <CheckCircle2Icon aria-hidden="true" />
          <AlertTitle>Return to your terminal</AlertTitle>
          <AlertDescription>
            ods will finish signing in automatically. This browser can now be
            closed. Login authorizes the CLI; it does not connect this device
            as a machine.
          </AlertDescription>
        </Alert>
        <section
          className="border-t pt-5"
          aria-labelledby="install-skill-title"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 id="install-skill-title" className="text-sm font-medium">
                Add the Odyshell skill
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Once published, install it for your coding agent with this
                command.
              </p>
            </div>
            <Badge variant="outline" className="shrink-0">
              Coming soon
            </Badge>
          </div>
          <CopyableValue
            value={odyshellSkillInstallCommand}
            label="Odyshell skill installation command"
            wrap
            className="mt-4 w-full rounded-xl border bg-muted/50 p-4 font-mono text-xs leading-5 text-foreground hover:bg-muted/70"
          />
        </section>
        <Link
          href="/dashboard"
          className={cn(buttonVariants({ variant: "outline" }), "w-full")}
        >
          Open dashboard
        </Link>
      </div>
    </ActivationShell>
  );
}
