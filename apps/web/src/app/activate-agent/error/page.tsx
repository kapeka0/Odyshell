import { ActivationShell } from "@/components/activation-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function AgentActivationErrorPage() {
  return (
    <ActivationShell
      title="Agent not registered"
      description="The request is invalid, expired, already used, or requires an administrator."
    >
      <Alert variant="destructive">
        <AlertTitle>Approval failed</AlertTitle>
        <AlertDescription>
          Return to the runtime and run ods agent login again.
        </AlertDescription>
      </Alert>
    </ActivationShell>
  );
}
