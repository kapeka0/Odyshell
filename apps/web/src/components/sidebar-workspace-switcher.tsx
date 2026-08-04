"use client";

import {
  useOrganization,
  useOrganizationList,
} from "@clerk/nextjs";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  PlusIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDashboard } from "@/components/dashboard-provider";
import { WorkspaceIdentityAvatar } from "@/components/identity-avatar";
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

export function SidebarWorkspaceSwitcher() {
  const router = useRouter();
  const { state } = useDashboard();
  const { isMobile } = useSidebar();
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const currentWorkspace = state.status === "ready" ? state.context.workspace : null;

  async function selectWorkspace(organizationId: string) {
    if (!setActive || organizationId === organization?.id) return;
    setPendingId(organizationId);
    try {
      await setActive({ organization: organizationId });
      router.refresh();
      toast.add({
        title: "Workspace changed",
        description: "Dashboard data now belongs to the selected workspace.",
        type: "success",
      });
    } catch {
      toast.add({
        title: "Workspace was not changed",
        description: "Your previous workspace remains active.",
        type: "error",
      });
    } finally {
      setPendingId(null);
    }
  }

  if (!isLoaded || !organizationLoaded || userMemberships.isLoading) {
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
                tooltip={organization?.name ?? "Select workspace"}
              />
            }
          >
            {organization ? (
              <WorkspaceIdentityAvatar
                identity={currentWorkspace?.avatarSeed ?? organization.id}
                name={currentWorkspace?.name ?? organization.name}
              />
            ) : (
              <span className="size-8 rounded-lg bg-muted" aria-hidden="true" />
            )}
            <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate font-medium">
                {currentWorkspace?.name ?? organization?.name ?? "Select workspace"}
              </span>
              {state.status === "ready" ? (
                <Badge
                  variant="outline"
                  className="mt-0.5 h-4 w-fit px-1.5 text-[10px] capitalize"
                >
                  {state.context.plan.id}
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
              <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
              {(userMemberships.data ?? []).map((membership) => (
                <DropdownMenuItem
                  key={membership.id}
                  disabled={pendingId !== null}
                  onClick={() =>
                    void selectWorkspace(membership.organization.id)
                  }
                >
                  {pendingId === membership.organization.id ? (
                    <Spinner />
                  ) : (
                    <WorkspaceIdentityAvatar
                      identity={membership.organization.id}
                      name={membership.organization.name}
                      className="size-6"
                    />
                  )}
                  <span className="truncate">
                    {membership.organization.name}
                  </span>
                  {membership.organization.id === organization?.id ? (
                    <CheckIcon aria-hidden="true" className="ml-auto" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => router.push("/onboarding")}>
                <PlusIcon aria-hidden="true" />
                Create workspace
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
