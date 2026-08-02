import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { statusTone, type StatusTone } from "@/lib/status-tone";

const badgeVariantByTone = {
  success: "success",
  info: "info",
  warning: "warning",
  danger: "destructive",
  neutral: "outline",
} satisfies Record<
  StatusTone,
  NonNullable<ComponentProps<typeof Badge>["variant"]>
>;

export function StatusBadge({
  status,
  children,
  ...props
}: Omit<ComponentProps<typeof Badge>, "variant"> & { status: string }) {
  return (
    <Badge variant={badgeVariantByTone[statusTone(status)]} {...props}>
      {children ?? label(status)}
    </Badge>
  );
}

function label(status: string): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}
