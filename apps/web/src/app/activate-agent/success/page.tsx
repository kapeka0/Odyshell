import { ActivationShell } from "@/components/activation-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function AgentActivationSuccessPage() {
  return (
    <ActivationShell
      title="Agent registered"
      description="The runtime can now request temporary Sessions."
    >
      <Alert>
        <AlertTitle>Approved</AlertTitle>
        <AlertDescription>You can close this page.</AlertDescription>
      </Alert>
    </ActivationShell>
  );
}
