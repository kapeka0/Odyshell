"use client";

import { Building2Icon, UserRoundIcon } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { facehashAvatarPath, vercelAvatarUrl } from "@/lib/avatar";
import { cn } from "@/lib/utils";

export function UserIdentityAvatar({
  identity,
  imageUrl,
  name,
  className,
}: {
  identity: string;
  imageUrl?: string;
  name: string;
  className?: string;
}) {
  return (
    <Avatar className={className}>
      <AvatarImage
        src={imageUrl ?? facehashAvatarPath(identity)}
        alt={name}
        referrerPolicy="no-referrer"
      />
      <AvatarFallback aria-label={`${name} avatar`}>
        <UserRoundIcon aria-hidden="true" className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}

export function WorkspaceIdentityAvatar({
  identity,
  name,
  className,
}: {
  identity: string;
  name: string;
  className?: string;
}) {
  return (
    <Avatar className={cn("rounded-lg", className)}>
      <AvatarImage
        src={vercelAvatarUrl(identity)}
        alt={`${name} workspace`}
        referrerPolicy="no-referrer"
        className="rounded-lg"
      />
      <AvatarFallback className="rounded-lg">
        <Building2Icon aria-hidden="true" className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}
