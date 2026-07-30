import { auth, clerkClient } from "@clerk/nextjs/server";
import type { CloudIdentity } from "@/lib/cloud-api";

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
