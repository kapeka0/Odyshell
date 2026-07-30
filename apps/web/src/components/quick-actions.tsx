"use client";

import { BookOpenIcon, CommandIcon, LayoutDashboardIcon, SearchIcon, TerminalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";

const actions = [
  { label: "Open dashboard", href: "/dashboard", shortcut: "D", icon: LayoutDashboardIcon },
  { label: "Authorize CLI", href: "/activate", shortcut: "A", icon: TerminalIcon },
  { label: "Read the architecture", href: "/#how-it-works", shortcut: "H", icon: BookOpenIcon },
] as const;

export function QuickActions() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const navigate = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="hidden min-w-44 justify-between md:inline-flex"
        onClick={() => setOpen(true)}
        aria-label="Open quick actions"
      >
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <SearchIcon data-icon="inline-start" />
          Quick actions
        </span>
        <kbd className="font-mono text-xs text-muted-foreground">⌘K</kbd>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => setOpen(true)}
        aria-label="Open quick actions"
      >
        <CommandIcon />
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Quick actions"
        description="Open an Odyshell destination"
      >
        <CommandInput placeholder="Search destinations…" />
        <CommandList>
          <CommandEmpty>No destination matches that search.</CommandEmpty>
          <CommandGroup heading="Odyshell">
            {actions.map((action) => (
              <CommandItem key={action.href} onSelect={() => navigate(action.href)}>
                <action.icon />
                <span>{action.label}</span>
                <CommandShortcut>⌘{action.shortcut}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
