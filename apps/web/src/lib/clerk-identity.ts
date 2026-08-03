import { auth, clerkClient } from "@clerk/nextjs/server";
import { unstable_cache } from "next/cache";
import type { CloudIdentity, CloudMember } from "@/lib/cloud-api";

export async function currentCloudIdentity(): Promise<CloudIdentity | null> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return null;
  return cloudIdentityFor(userId, orgId);
}

export async function cloudIdentityFor(
  userId: string,
  orgId: string,
): Promise<CloudIdentity> {
  const clerk = await clerkClient();
  const organization = await clerk.organizations.getOrganization({
    organizationId: orgId,
  });
  return {
    userId,
    organization: {
      externalId: organization.id,
      slug:
        organization.slug ??
        organization.id.toLowerCase().replaceAll("_", "-"),
      name: organization.name,
    },
  };
}

export const organizationMembers = unstable_cache(
  async (organizationId: string): Promise<CloudMember[]> => {
    const clerk = await clerkClient();
    const memberships = await clerk.organizations.getOrganizationMembershipList({
      organizationId,
      limit: 100,
    });
    return memberships.data.flatMap((membership) => {
      const user = membership.publicUserData;
      if (!user) return [];
      const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
      return [{
        id: user.userId,
        name: fullName || user.identifier || "Member",
        ...(user.hasImage ? { imageUrl: user.imageUrl } : {}),
      }];
    });
  },
  ["clerk-organization-members"],
  { revalidate: 60 },
);
