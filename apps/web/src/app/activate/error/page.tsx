import { CircleXIcon } from "lucide-react";
import Link from "next/link";
import { ActivationShell } from "@/components/activation-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  deviceApprovalMessage,
  deviceApprovalReason,
} from "@/lib/device-activation";
import { cn } from "@/lib/utils";

export default async function ActivationErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>;
}) {
  const params = await searchParams;
  const reason = deviceApprovalReason(
    typeof params.reason === "string" ? params.reason : undefined,
  );

  return (
    <ActivationShell
      title="CLI not connected"
      description="Odyshell did not issue a CLI credential."
    >
      <div className="flex flex-col gap-5">
        <Alert variant="destructive">
          <CircleXIcon aria-hidden="true" />
          <AlertTitle>Approval failed</AlertTitle>
          <AlertDescription>{deviceApprovalMessage(reason)}</AlertDescription>
        </Alert>
        <Link
          href="/dashboard"
          className={cn(buttonVariants({ variant: "outline" }), "w-full")}
        >
          Return to dashboard
        </Link>
      </div>
    </ActivationShell>
  );
}
