import { CheckCircle2Icon } from "lucide-react";
import Link from "next/link";
import { ActivationShell } from "@/components/activation-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
            closed.
          </AlertDescription>
        </Alert>
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
