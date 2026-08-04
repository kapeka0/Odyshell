import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function HostShellWarning() {
  return (
    <Alert>
      <AlertTitle>Host Shell runs with user authority</AlertTitle>
      <AlertDescription>
        {"Commands run as the operating-system user running the Client and start in that user's Home by default. A command can choose another working directory, but that does not narrow access. Commands can access that user's files, credentials, network, and services. There is no sandbox or isolation, and changes may persist after the Session ends."}
      </AlertDescription>
    </Alert>
  );
}
