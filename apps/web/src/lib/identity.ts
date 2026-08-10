import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import type { ControlIdentity, ControlMember } from "@/lib/control-api";
import { getAuth } from "@/lib/auth";
import {
  identityRole,
  type IdentityRole,
} from "@/lib/identity-permissions";

export type HumanIdentity = {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  role: IdentityRole;
};

export const currentHumanSession = cache(async () => {
  const requestHeaders = await headers();
  const auth = getAuth();
  return auth.api.getSession({ headers: requestHeaders });
});

export const currentHumanIdentity = cache(
  async (): Promise<HumanIdentity | null> => {
    const requestHeaders = await headers();
    const session = await currentHumanSession();
    if (!session?.session.activeOrganizationId) return null;
    const auth = getAuth();

    const [organization, member] = await Promise.all([
      auth.api.getFullOrganization({
        headers: requestHeaders,
        query: { organizationId: session.session.activeOrganizationId },
      }),
      auth.api.getActiveMember({ headers: requestHeaders }),
    ]);
    const role = member ? identityRole(member.role) : null;
    if (!organization || !role) return null;

    return {
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        image: session.user.image,
      },
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
      },
      role,
    };
  },
);

export async function currentControlIdentity(): Promise<ControlIdentity | null> {
  const identity = await currentHumanIdentity();
  if (!identity) return null;
  return {
    userId: identity.user.id,
    role: identity.role,
    organization: {
      externalId: identity.organization.id,
      slug: identity.organization.slug,
      name: identity.organization.name,
    },
  };
}

export async function organizationMembers(): Promise<ControlMember[]> {
  const requestHeaders = await headers();
  const identity = await currentHumanIdentity();
  if (!identity) return [];
  const auth = getAuth();
  const organization = await auth.api.getFullOrganization({
    headers: requestHeaders,
    query: { organizationId: identity.organization.id, membersLimit: 100 },
  });
  return (organization?.members ?? []).map((member) => ({
    id: member.userId,
    name: member.user.name,
    ...(member.user.image ? { imageUrl: member.user.image } : {}),
  }));
}
