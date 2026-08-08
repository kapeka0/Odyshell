"use client";

import { BotIcon, Building2Icon, UserRoundIcon } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { facehashAvatarPath } from "@/lib/avatar";
import { agentBrand } from "@/lib/agent-brand";
import { cn } from "@/lib/utils";

export function AgentIdentityAvatar({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const brand = agentBrand(name);
  if (brand) {
    return (
      <Avatar className={cn("rounded-lg bg-white p-1.5", className)}>
        <AvatarImage
          src={brand.src}
          alt={`${brand.label} logo`}
          className="rounded-sm object-contain"
        />
        <AvatarFallback
          aria-label={`${name} avatar`}
          className="rounded-sm bg-white text-neutral-700"
        >
          <BotIcon aria-hidden="true" className="size-4" />
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <Avatar className={cn("rounded-lg", className)}>
      <AvatarFallback
        aria-label={`${name} avatar`}
        className="rounded-lg"
      >
        <BotIcon aria-hidden="true" className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}

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

export function OrganizationIdentityAvatar({
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
        src={facehashAvatarPath(identity)}
        alt={`${name} organization`}
        referrerPolicy="no-referrer"
        className="rounded-lg"
      />
      <AvatarFallback className="rounded-lg">
        <Building2Icon aria-hidden="true" className="size-4" />
      </AvatarFallback>
    </Avatar>
  );
}
