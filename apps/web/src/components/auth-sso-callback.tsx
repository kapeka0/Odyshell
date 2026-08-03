"use client";

import { useClerk, useSignIn, useSignUp } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function AuthSsoCallback({ destination }: { destination: string }) {
  const clerk = useClerk();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const router = useRouter();
  const hasRun = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clerk.loaded || hasRun.current) return;
    hasRun.current = true;

    function navigate(url: string) {
      if (url.startsWith("http")) {
        window.location.assign(url);
        return;
      }
      router.replace(url);
    }

    async function finalizeSignIn() {
      await signIn.finalize({
        navigate: ({ session, decorateUrl }) => {
          navigate(
            decorateUrl(session.currentTask ? "/onboarding" : destination),
          );
        },
      });
    }

    async function finalizeSignUp() {
      await signUp.finalize({
        navigate: ({ session, decorateUrl }) => {
          navigate(
            decorateUrl(session.currentTask ? "/onboarding" : destination),
          );
        },
      });
    }

    async function completeGoogleSignIn() {
      try {
        if (signIn.status === "complete") {
          await finalizeSignIn();
          return;
        }

        if (signUp.isTransferable) {
          const transfer = await signIn.create({ transfer: true });
          if (transfer.error) throw transfer.error;
          if ((signIn.status as typeof signIn.status | "complete") === "complete") {
            await finalizeSignIn();
            return;
          }
        }

        if (signIn.isTransferable) {
          const transfer = await signUp.create({ transfer: true });
          if (transfer.error) throw transfer.error;
          if (signUp.status === "complete") {
            await finalizeSignUp();
            return;
          }
        }

        if (signUp.status === "complete") {
          await finalizeSignUp();
          return;
        }

        const sessionId =
          signIn.existingSession?.sessionId ?? signUp.existingSession?.sessionId;
        if (sessionId) {
          await clerk.setActive({
            session: sessionId,
            navigate: ({ session, decorateUrl }) => {
              navigate(
                decorateUrl(
                  session?.currentTask ? "/onboarding" : destination,
                ),
              );
            },
          });
          return;
        }

        setError("Google sign-in needs additional verification. Try email instead.");
      } catch {
        setError("Google sign-in could not be completed. Try again.");
      }
    }

    void completeGoogleSignIn();
  }, [clerk, destination, router, signIn, signUp]);

  return (
    <AuthShell
      title={error ? "Could not sign in" : "Completing sign in"}
      description={
        error ?? "Odyshell is securely completing your Google sign-in."
      }
    >
      {error ? (
        <Link
          href={`/sign-in?redirect_url=${encodeURIComponent(destination)}`}
          className={cn(buttonVariants(), "w-full")}
        >
          Try again
        </Link>
      ) : (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
          <Spinner />
          Signing in
        </div>
      )}
      <div id="clerk-captcha" />
    </AuthShell>
  );
}
