"use client";

import { useAuth, useOrganizationList } from "@clerk/nextjs";
import { Building2Icon, CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

const workspaceNameSchema = z
  .string()
  .trim()
  .min(2, "Use at least 2 characters")
  .max(64, "Use at most 64 characters");

export function WorkspaceOnboarding() {
  const router = useRouter();
  const { orgId } = useAuth();
  const { isLoaded, createOrganization, setActive, userMemberships } =
    useOrganizationList({
      userMemberships: { infinite: true },
    });
  const [name, setName] = useState("");
  const [pendingOrganizationId, setPendingOrganizationId] = useState<
    string | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (orgId) router.replace("/dashboard");
  }, [orgId, router]);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = workspaceNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid workspace name");
      return;
    }
    if (!createOrganization || !setActive) return;

    setError(null);
    setPendingOrganizationId("new");
    try {
      const organization = await createOrganization({ name: parsed.data });
      await activateWorkspace(organization.id);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not create the workspace",
      );
      setPendingOrganizationId(null);
    }
  }

  async function activateWorkspace(organizationId: string) {
    if (!setActive) return;
    setError(null);
    setPendingOrganizationId(organizationId);
    try {
      await setActive({ organization: organizationId });
      router.replace("/dashboard");
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not select the workspace",
      );
      setPendingOrganizationId(null);
    }
  }

  if (!isLoaded || userMemberships.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const memberships = userMemberships.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      {memberships.length > 0 ? (
        <div className="flex flex-col gap-2">
          {memberships.map((membership) => (
            <Button
              key={membership.id}
              type="button"
              variant="outline"
              className="justify-start"
              disabled={pendingOrganizationId !== null}
              onClick={() => void activateWorkspace(membership.organization.id)}
            >
              {pendingOrganizationId === membership.organization.id ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Building2Icon data-icon="inline-start" />
              )}
              {membership.organization.name}
              {orgId === membership.organization.id ? (
                <CheckIcon data-icon="inline-end" />
              ) : null}
            </Button>
          ))}
        </div>
      ) : null}

      {memberships.length > 0 ? <Separator /> : null}

      <form onSubmit={createWorkspace}>
        <FieldGroup>
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="workspace-name">Workspace name</FieldLabel>
            <Input
              id="workspace-name"
              name="workspace-name"
              autoComplete="organization"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={Boolean(error)}
              placeholder="Acme"
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <Button
            type="submit"
            disabled={
              pendingOrganizationId !== null ||
              !createOrganization ||
              !setActive
            }
          >
            {pendingOrganizationId === "new" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Building2Icon data-icon="inline-start" />
            )}
            Create workspace
          </Button>
        </FieldGroup>
      </form>

      <Alert>
        <AlertTitle>One workspace is enough to start</AlertTitle>
        <AlertDescription>
          Machines, Agent Access and control events remain isolated inside the
          selected workspace.
        </AlertDescription>
      </Alert>
    </div>
  );
}
