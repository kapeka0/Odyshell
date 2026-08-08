import { TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function HostShellWarning({
  localPolicy = false,
}: {
  localPolicy?: boolean;
}) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>Host Shell grants full user authority</AlertTitle>
      <AlertDescription>
        <p>
          {"Commands run as the operating-system user running the Client and start in that user's Home by default. A command can choose another working directory, but that does not narrow access. Commands can access that user's files, credentials, network, and services. There is no sandbox or isolation, and changes may persist after the Task ends."}
        </p>
        {localPolicy ? (
          <p>
            Structured capabilities are disabled because Host Shell can
            already use everything available to that operating-system user.
            Deselect it to configure narrower, typed access.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
