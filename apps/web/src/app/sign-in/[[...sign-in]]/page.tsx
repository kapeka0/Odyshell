import { SignIn } from "@clerk/nextjs";
import { AuthShell } from "@/components/auth-shell";

export default function SignInPage() {
  return (
    <AuthShell
      title="Welcome back"
      description="Sign in to your Odyshell workspace."
    >
      <SignIn />
    </AuthShell>
  );
}
