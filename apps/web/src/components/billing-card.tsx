"use client";

import { CheckIcon, CreditCardIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type { CloudContext } from "@/lib/cloud-api";

export function BillingCard({ context }: { context: CloudContext }) {
  const [pending, setPending] = useState(false);
  const owner = context.currentMemberRole === "owner";
  const pro = context.plan.id === "pro";

  async function openBilling(path: "checkout" | "portal") {
    setPending(true);
    try {
      const response = await fetch(`/api/billing/${path}`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? "Billing is unavailable");
      window.location.assign(body.url);
    } catch (reason) {
      toast.add({
        title: "Billing is unavailable",
        description: reason instanceof Error ? reason.message : "Try again.",
        type: "error",
      });
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Plan and billing</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Pro is billed per active Organization member.</p>
          </div>
          <Badge variant={pro ? "secondary" : "outline"} className="capitalize">{context.plan.id}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 pt-6 md:grid-cols-[minmax(0,1fr)_14rem]">
        <div>
          <p className="text-3xl font-semibold tracking-tight">$30 <span className="text-sm font-normal text-muted-foreground">/ member / month</span></p>
          <ul className="mt-5 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
            <PlanItem>Up to 20 members</PlanItem>
            <PlanItem>Up to 20 Machines</PlanItem>
            <PlanItem>Unlimited Agents</PlanItem>
            <PlanItem>Recorded Session timelines</PlanItem>
          </ul>
        </div>
        <dl className="grid content-start gap-3 rounded-xl border bg-muted/35 p-4 text-sm">
          <div><dt className="text-xs text-muted-foreground">Members billed</dt><dd className="mt-1 font-mono">{context.members.length}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Monthly total</dt><dd className="mt-1 font-mono">${context.members.length * 30}</dd></div>
        </dl>
      </CardContent>
      <CardFooter className="justify-end border-t bg-card">
        {owner ? (
          <Button disabled={pending} onClick={() => void openBilling(pro ? "portal" : "checkout")}>
            {pending ? <Spinner data-icon="inline-start" /> : <CreditCardIcon data-icon="inline-start" />}
            {pro ? "Manage billing" : "Upgrade to Pro"}
          </Button>
        ) : <p className="text-sm text-muted-foreground">Only the Organization owner can manage billing.</p>}
      </CardFooter>
    </Card>
  );
}

function PlanItem({ children }: { children: React.ReactNode }) {
  return <li className="flex items-center gap-2"><CheckIcon className="size-4 text-status-success" />{children}</li>;
}
