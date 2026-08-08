"use client";

import { Building2Icon, CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

const organizationNameSchema = z
  .string()
  .trim()
  .min(2, "Use at least 2 characters")
  .max(64, "Use at most 64 characters");

export function OrganizationOnboarding() {
  const router = useRouter();
  const session = authClient.useSession();
  const organizations = authClient.useListOrganizations();
  const activeOrganization = authClient.useActiveOrganization();
  const [name, setName] = useState<string | null>(null);
  const [pendingOrganizationId, setPendingOrganizationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const organizationName = name ?? suggestedOrganizationName(session.data?.user.name);

  useEffect(() => {
    if (activeOrganization.data?.id) router.replace("/dashboard");
  }, [activeOrganization.data?.id, router]);

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = organizationNameSchema.safeParse(organizationName);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid organization name");
      return;
    }

    setError(null);
    setPendingOrganizationId("new");
    const result = await authClient.organization.create({
      name: parsed.data,
      slug: organizationSlug(parsed.data),
    });
    if (result.error || !result.data) {
      setError(result.error?.message ?? "Could not create the organization");
      setPendingOrganizationId(null);
      return;
    }
    await activateOrganization(result.data.id);
  }

  async function activateOrganization(organizationId: string) {
    setError(null);
    setPendingOrganizationId(organizationId);
    const result = await authClient.organization.setActive({ organizationId });
    if (result.error) {
      setError(result.error.message ?? "Could not select the organization");
      setPendingOrganizationId(null);
      return;
    }
    router.replace("/dashboard");
    router.refresh();
  }

  if (session.isPending || organizations.isPending || activeOrganization.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const availableOrganizations = organizations.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      {availableOrganizations.length > 0 ? (
        <div className="flex flex-col gap-2">
          {availableOrganizations.map((organization) => (
            <Button
              key={organization.id}
              type="button"
              variant="outline"
              className="justify-start"
              disabled={pendingOrganizationId !== null}
              onClick={() => void activateOrganization(organization.id)}
            >
              {pendingOrganizationId === organization.id ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Building2Icon data-icon="inline-start" />
              )}
              {organization.name}
              {activeOrganization.data?.id === organization.id ? (
                <CheckIcon data-icon="inline-end" />
              ) : null}
            </Button>
          ))}
        </div>
      ) : null}

      {availableOrganizations.length > 0 ? <Separator /> : null}

      <form onSubmit={createOrganization}>
        <FieldGroup>
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="organization-name">Organization name</FieldLabel>
            <Input
              id="organization-name"
              name="organization-name"
              autoComplete="organization"
              value={organizationName}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={Boolean(error)}
              placeholder="Acme Operations"
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <Button type="submit" disabled={pendingOrganizationId !== null}>
            {pendingOrganizationId === "new" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Building2Icon data-icon="inline-start" />
            )}
            Create organization
          </Button>
        </FieldGroup>
      </form>

      <Alert>
        <AlertTitle>One organization is enough to start</AlertTitle>
        <AlertDescription>
          Machines, Agents, policies and audit events remain isolated inside the
          selected organization.
        </AlertDescription>
      </Alert>
    </div>
  );
}

function suggestedOrganizationName(name?: string | null): string {
  const firstName = name?.trim().split(/\s+/)[0];
  if (!firstName) return "My Organization";
  return `${firstName}${firstName.endsWith("s") ? "'" : "'s"} Organization`;
}

function organizationSlug(name: string): string {
  const prefix = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "organization";
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
