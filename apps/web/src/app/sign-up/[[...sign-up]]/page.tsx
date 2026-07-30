import { SignUp } from "@clerk/nextjs";
import { AuthShell } from "@/components/auth-shell";

export default function SignUpPage() {
  return (
    <AuthShell
      title="Create your workspace"
      description="Start with a private machine and scoped agent access."
    >
      <SignUp />
    </AuthShell>
  );
}
