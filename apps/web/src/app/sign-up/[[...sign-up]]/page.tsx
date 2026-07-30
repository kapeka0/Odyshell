import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="grid min-h-svh place-items-center px-4 py-12">
      <SignUp />
    </main>
  );
}
