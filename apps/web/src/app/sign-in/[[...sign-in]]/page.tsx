import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="grid min-h-svh place-items-center px-4 py-12">
      <SignIn />
    </main>
  );
}
