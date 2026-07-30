"use client";

import { useAuth, useSignIn, useSignUp } from "@clerk/nextjs";
import { ArrowLeftIcon, MailIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { z } from "zod";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const emailSchema = z.string().trim().email("Enter a valid email address");
const verificationCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code");

type AuthMode = "sign-in" | "sign-up";

export function AuthForm({
  mode,
  destination,
}: {
  mode: AuthMode;
  destination: string;
}) {
  return mode === "sign-in" ? (
    <SignInForm destination={destination} />
  ) : (
    <SignUpForm destination={destination} />
  );
}

function SignInForm({ destination }: { destination: string }) {
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const { signIn, fetchStatus } = useSignIn();
  const [step, setStep] = useState<"email" | "code">("email");
  const [emailAddress, setEmailAddress] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pending = fetchStatus === "fetching";

  useEffect(() => {
    if (isSignedIn) router.replace(destination);
  }, [destination, isSignedIn, router]);

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = emailSchema.safeParse(emailAddress);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid email address");
      return;
    }
    setError(null);
    const result = await signIn.emailCode.sendCode({
      emailAddress: parsed.data,
    });
    if (result.error) {
      setError(clerkErrorMessage(result.error));
      return;
    }
    setEmailAddress(parsed.data);
    setStep("code");
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = verificationCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid verification code");
      return;
    }
    setError(null);
    const result = await signIn.emailCode.verifyCode({ code: parsed.data });
    if (result.error) {
      setError(clerkErrorMessage(result.error));
      return;
    }
    if (signIn.status !== "complete") {
      setError("Additional account verification is required.");
      return;
    }
    await signIn.finalize({
      navigate: ({ session, decorateUrl }) => {
        navigateTo(
          decorateUrl(session.currentTask ? "/onboarding" : destination),
          router,
        );
      },
    });
  }

  if (step === "code") {
    return (
      <form onSubmit={verifyCode}>
        <FieldGroup>
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="sign-in-code">Verification code</FieldLabel>
            <Input
              id="sign-in-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={Boolean(error)}
              autoFocus
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            Verify email
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void signIn.reset();
              setCode("");
              setError(null);
              setStep("email");
            }}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Use another email
          </Button>
        </FieldGroup>
      </form>
    );
  }

  return (
    <form onSubmit={sendCode}>
      <FieldGroup>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="sign-in-email">Email address</FieldLabel>
          <Input
            id="sign-in-email"
            name="email"
            type="email"
            autoComplete="email"
            value={emailAddress}
            onChange={(event) => setEmailAddress(event.target.value)}
            aria-invalid={Boolean(error)}
            autoFocus
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <MailIcon data-icon="inline-start" />
          )}
          Continue with email
        </Button>
        <AuthSwitch mode="sign-in" destination={destination} />
      </FieldGroup>
    </form>
  );
}

function SignUpForm({ destination }: { destination: string }) {
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const { signUp, fetchStatus } = useSignUp();
  const [step, setStep] = useState<"email" | "code">("email");
  const [emailAddress, setEmailAddress] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pending = fetchStatus === "fetching";

  useEffect(() => {
    if (isSignedIn) router.replace(destination);
  }, [destination, isSignedIn, router]);

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = emailSchema.safeParse(emailAddress);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid email address");
      return;
    }
    setError(null);
    const created = await signUp.create({ emailAddress: parsed.data });
    if (created.error) {
      setError(clerkErrorMessage(created.error));
      return;
    }
    const sent = await signUp.verifications.sendEmailCode();
    if (sent.error) {
      setError(clerkErrorMessage(sent.error));
      return;
    }
    setEmailAddress(parsed.data);
    setStep("code");
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = verificationCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid verification code");
      return;
    }
    setError(null);
    const result = await signUp.verifications.verifyEmailCode({
      code: parsed.data,
    });
    if (result.error) {
      setError(clerkErrorMessage(result.error));
      return;
    }
    if (signUp.status !== "complete") {
      setError("Complete the remaining account requirements.");
      return;
    }
    await signUp.finalize({
      navigate: ({ session, decorateUrl }) => {
        navigateTo(
          decorateUrl(session.currentTask ? "/onboarding" : destination),
          router,
        );
      },
    });
  }

  if (step === "code") {
    return (
      <form onSubmit={verifyCode}>
        <FieldGroup>
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="sign-up-code">Verification code</FieldLabel>
            <Input
              id="sign-up-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-invalid={Boolean(error)}
              autoFocus
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            Create workspace account
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void signUp.reset();
              setCode("");
              setError(null);
              setStep("email");
            }}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Use another email
          </Button>
          <div id="clerk-captcha" />
        </FieldGroup>
      </form>
    );
  }

  return (
    <form onSubmit={sendCode}>
      <FieldGroup>
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor="sign-up-email">Work email</FieldLabel>
          <Input
            id="sign-up-email"
            name="email"
            type="email"
            autoComplete="email"
            value={emailAddress}
            onChange={(event) => setEmailAddress(event.target.value)}
            aria-invalid={Boolean(error)}
            autoFocus
          />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <MailIcon data-icon="inline-start" />
          )}
          Continue with email
        </Button>
        <AuthSwitch mode="sign-up" destination={destination} />
        <div id="clerk-captcha" />
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
  const label =
    mode === "sign-in" ? "Create an account" : "Sign in instead";
  const href = `${target}?redirect_url=${encodeURIComponent(destination)}`;

  return (
    <Link
      href={href}
      className={cn(buttonVariants({ variant: "ghost" }), "w-full")}
    >
      {label}
    </Link>
  );
}

function clerkErrorMessage(error: {
  longMessage?: string;
  message?: string;
}): string {
  return error.longMessage ?? error.message ?? "Authentication failed";
}

function navigateTo(
  url: string,
  router: ReturnType<typeof useRouter>,
): void {
  if (url.startsWith("http")) {
    window.location.assign(url);
    return;
  }
  router.replace(url);
}
