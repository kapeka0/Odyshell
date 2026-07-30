"use client";

import { CommandIcon, LayoutDashboardIcon, SearchIcon, TerminalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Command,
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
  { label: "View machines", href: "/dashboard/machines", shortcut: "M", icon: TerminalIcon },
  { label: "Manage agent access", href: "/dashboard/access", shortcut: "A", icon: CommandIcon },
  { label: "Review activity", href: "/dashboard/activity", shortcut: "R", icon: SearchIcon },
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
          <SearchIcon aria-hidden="true" data-icon="inline-start" />
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
        <CommandIcon aria-hidden="true" />
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Quick actions"
        description="Open an Odyshell destination"
      >
        <Command>
          <CommandInput placeholder="Search destinations…" />
          <CommandList>
            <CommandEmpty>No destination matches that search.</CommandEmpty>
            <CommandGroup heading="Odyshell">
              {actions.map((action) => (
                <CommandItem key={action.href} onSelect={() => navigate(action.href)}>
                  <action.icon aria-hidden="true" />
                  <span>{action.label}</span>
                  <CommandShortcut>⌘{action.shortcut}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
