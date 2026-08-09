"use client";

import { ArrowLeftIcon, ShieldCheckIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { z } from "zod";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  password: z
    .string()
    .min(12, "Use at least 12 characters")
    .max(128, "Use at most 128 characters"),
});

const signUpSchema = credentialsSchema.extend({
  name: z.string().trim().min(2, "Use at least 2 characters").max(80),
});

type AuthMode = "sign-in" | "sign-up";

export function AuthForm({
  mode,
  destination,
}: {
  mode: AuthMode;
  destination: string;
}) {
  const router = useRouter();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [googlePending, setGooglePending] = useState(false);
  const [oidcPending, setOidcPending] = useState(false);

  useEffect(() => {
    if (session) router.replace(destination);
  }, [destination, router, session]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed =
      mode === "sign-up"
        ? signUpSchema.safeParse({ name, email, password })
        : credentialsSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your account details");
      return;
    }

    setError(null);
    setPending(true);
    const result =
      mode === "sign-up"
        ? await authClient.signUp.email({
            name: name.trim(),
            email: email.trim(),
            password,
          })
        : await authClient.signIn.email({
            email: email.trim(),
            password,
            rememberMe: true,
          });
    setPending(false);
    if (result.error) {
      setError(identityErrorMessage(result.error));
      return;
    }
    router.replace(destination);
    router.refresh();
  }

  async function continueWithGoogle() {
    setError(null);
    setGooglePending(true);
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: destination,
      newUserCallbackURL: destination,
      errorCallbackURL: `/sign-in?redirect_url=${encodeURIComponent(destination)}`,
    });
    if (result?.error) {
      setError(identityErrorMessage(result.error));
      setGooglePending(false);
    }
  }

  async function continueWithOidc() {
    setError(null);
    setOidcPending(true);
    const result = await authClient.signIn.oauth2({
      providerId: process.env.NEXT_PUBLIC_OIDC_PROVIDER_ID ?? "oidc",
      callbackURL: destination,
      newUserCallbackURL: destination,
      errorCallbackURL: `/sign-in?redirect_url=${encodeURIComponent(destination)}`,
    });
    if (result?.error) {
      setError(identityErrorMessage(result.error));
      setOidcPending(false);
    }
  }

  const googleEnabled = process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === "true";
  const oidcEnabled = process.env.NEXT_PUBLIC_OIDC_AUTH_ENABLED === "true";
  const disabled = pending || googlePending || oidcPending || sessionPending;

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        {googleEnabled ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => void continueWithGoogle()}
          >
            {googlePending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Image
                src="/brand/google.svg"
                alt=""
                width={16}
                height={16}
                aria-hidden="true"
              />
            )}
            Continue with Google
          </Button>
        ) : null}

        {oidcEnabled ? (
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => void continueWithOidc()}
          >
            {oidcPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ShieldCheckIcon data-icon="inline-start" />
            )}
            Continue with SSO
          </Button>
        ) : null}

        {googleEnabled || oidcEnabled ? (
          <div className="flex items-center gap-3" aria-hidden="true">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">Or</span>
            <Separator className="flex-1" />
          </div>
        ) : null}

        {mode === "sign-up" ? (
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="auth-name">Name</FieldLabel>
            <Input
              id="auth-name"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={Boolean(error)}
              autoFocus
            />
          </Field>
        ) : null}

        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="auth-email">Email address</FieldLabel>
          <Input
            id="auth-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={Boolean(error)}
            autoFocus={mode === "sign-in"}
          />
        </Field>

        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="auth-password">Password</FieldLabel>
          <Input
            id="auth-password"
            name="password"
            type="password"
            autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={Boolean(error)}
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>

        <Button type="submit" disabled={disabled}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {mode === "sign-up" ? "Create account" : "Sign in"}
        </Button>
        <AuthSwitch mode={mode} destination={destination} />
      </FieldGroup>
    </form>
  );
}

function AuthSwitch({
  mode,
  destination,
}: {
  mode: AuthMode;
  destination: string;
}) {
  const target = mode === "sign-in" ? "/sign-up" : "/sign-in";
  const label = mode === "sign-in" ? "Create an account" : "Sign in instead";
  return (
    <Link
      href={`${target}?redirect_url=${encodeURIComponent(destination)}`}
      className={cn(buttonVariants({ variant: "ghost" }), "w-full")}
    >
      <ArrowLeftIcon data-icon="inline-start" />
      {label}
    </Link>
  );
}

function identityErrorMessage(error: { message?: string }): string {
  return error.message ?? "Authentication failed";
}
