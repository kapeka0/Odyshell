"use client";

import {
  CheckIcon,
  ChevronsUpDownIcon,
  PlusIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDashboard } from "@/components/dashboard-provider";
import { OrganizationIdentityAvatar } from "@/components/identity-avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";

export function SidebarOrganizationSwitcher() {
  const router = useRouter();
  const { state } = useDashboard();
  const { isMobile } = useSidebar();
  const activeOrganization = authClient.useActiveOrganization();
  const organizations = authClient.useListOrganizations();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const currentOrganization = state.status === "ready" ? state.context.organization : null;

  async function selectOrganization(organizationId: string) {
    if (organizationId === activeOrganization.data?.id) return;
    setPendingId(organizationId);
    const result = await authClient.organization.setActive({ organizationId });
    if (!result.error) {
      router.refresh();
      toast.add({
        title: "Organization changed",
        description: "Dashboard data now belongs to the selected organization.",
        type: "success",
      });
    } else {
      toast.add({
        title: "Organization was not changed",
        description: "Your previous organization remains active.",
        type: "error",
      });
    }
    setPendingId(null);
  }

  if (activeOrganization.isPending || organizations.isPending) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                tooltip={activeOrganization.data?.name ?? "Select organization"}
              />
            }
          >
            {activeOrganization.data ? (
              <OrganizationIdentityAvatar
                identity={currentOrganization?.avatarSeed ?? activeOrganization.data.id}
                name={currentOrganization?.name ?? activeOrganization.data.name}
              />
            ) : (
              <span className="size-8 rounded-lg bg-muted" aria-hidden="true" />
            )}
            <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate font-medium">
                {currentOrganization?.name ?? activeOrganization.data?.name ?? "Select organization"}
              </span>
              {state.status === "ready" ? (
                <Badge
                  variant="outline"
                  className="mt-0.5 h-4 w-fit px-1.5 text-[10px] capitalize"
                >
                  Self-hosted
                </Badge>
              ) : null}
            </div>
            <ChevronsUpDownIcon
              aria-hidden="true"
              className="ml-auto group-data-[collapsible=icon]:hidden"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side={isMobile ? "bottom" : "right"}
            align="start"
            className="min-w-56"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {(organizations.data ?? []).map((organization) => (
                <DropdownMenuItem
                  key={organization.id}
                  disabled={pendingId !== null}
                  onClick={() => void selectOrganization(organization.id)}
                >
                  {pendingId === organization.id ? (
                    <Spinner />
                  ) : (
                    <OrganizationIdentityAvatar
                      identity={organization.id}
                      name={organization.name}
                      className="size-6"
                    />
                  )}
                  <span className="truncate">{organization.name}</span>
                  {organization.id === activeOrganization.data?.id ? (
                    <CheckIcon aria-hidden="true" className="ml-auto" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => router.push("/onboarding")}>
                <PlusIcon aria-hidden="true" />
                Create organization
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
