"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export type SidebarNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

export function SidebarNav({
  label,
  items,
  className,
}: {
  label: string;
  items: readonly SidebarNavItem[];
  className?: string;
}) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  return (
    <SidebarGroup className={className}>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const active =
            (item.href === "/dashboard"
              ? pathname === item.href
              : pathname.startsWith(item.href));

          return (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                render={
                  <Link
                    href={item.href}
                    onClick={() => setOpenMobile(false)}
                  />
                }
                isActive={active}
                tooltip={item.label}
              >
                <item.icon aria-hidden="true" />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
