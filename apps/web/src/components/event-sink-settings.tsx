"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type {
  CloudEventSink,
  CloudEventSinkState,
} from "@/lib/cloud-api";

type DetailLevel = CloudEventSink["detailLevel"];

const detailLevels: Array<{ value: DetailLevel; label: string }> = [
  { value: "privacy-minimal", label: "Privacy-minimal" },
  { value: "operational", label: "Operational" },
  { value: "diagnostic", label: "Diagnostic" },
];

export function EventSinkSettings() {
  const [sink, setSink] = useState<CloudEventSink | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [detailLevel, setDetailLevel] =
    useState<DetailLevel>("privacy-minimal");
  const [signingSecret, setSigningSecret] = useState("");

  useEffect(() => {
    void fetch("/api/event-sink", { cache: "no-store" })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as CloudEventSinkState)
          : Promise.reject(new Error("request_failed")),
      )
      .then((state) => {
        setSink(state.data);
        if (state.data) {
          setEndpoint(state.data.endpoint);
          setDetailLevel(state.data.detailLevel);
        }
      })
      .catch(() => undefined);
  }, []);

  async function save() {
    setPending(true);
    try {
      const response = await fetch("/api/event-sink", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint, detailLevel, signingSecret }),
      });
      const result = (await response.json()) as {
        data?: CloudEventSink;
        error?: string;
      };
      if (!response.ok || !result.data) {
        throw new Error(result.error ?? "event_sink_save_failed");
      }
      setSink(result.data);
      setSigningSecret("");
      setOpen(false);
      toast.add({ title: "Event Sink saved", type: "success" });
    } catch (error) {
      toast.add({
        title: "Could not save Event Sink",
        description:
          error instanceof Error ? error.message : "event_sink_save_failed",
        type: "error",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-heading text-lg font-medium">Event Sink</h2>
        <p className="text-sm text-muted-foreground">Signed Timeline delivery.</p>
      </div>
      <Card>
        <CardContent className="p-0">
          <Field orientation="responsive" className="p-4">
            <FieldContent>
              <FieldTitle>{sink ? sink.endpoint : "Not configured"}</FieldTitle>
              <FieldDescription>
                {sink ? `Secret ${sink.signingSecret}` : "Deliver signed events to your own HTTPS endpoint."} <Link href="/docs/event-sinks">Learn more</Link>
              </FieldDescription>
            </FieldContent>
            <div className="flex w-full items-center justify-end gap-3 @md/field-group:w-auto">
              {sink ? <Badge variant="outline">{detailLabel(sink.detailLevel)}</Badge> : null}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button variant="outline" />}>
              {sink ? "Configure" : "Add"}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Event Sink</DialogTitle>
                <DialogDescription>
                  Send signed Timeline events to a public HTTPS endpoint.
                </DialogDescription>
              </DialogHeader>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="sink-endpoint">Endpoint</FieldLabel>
                  <Input
                    id="sink-endpoint"
                    type="url"
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                    placeholder="https://events.example/odyshell"
                    required
                  />
                  <FieldDescription>Public HTTPS destination for signed deliveries.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="sink-detail">Detail</FieldLabel>
                  <Select
                    items={detailLevels}
                    value={detailLevel}
                    onValueChange={(value) =>
                      setDetailLevel(value as DetailLevel)
                    }
                  >
                    <SelectTrigger id="sink-detail" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {detailLevels.map((level) => (
                          <SelectItem key={level.value} value={level.value}>
                            {level.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>Controls the detail sent independently from Session logging.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="sink-secret">Secret</FieldLabel>
                  <Input
                    id="sink-secret"
                    type="password"
                    value={signingSecret}
                    onChange={(event) => setSigningSecret(event.target.value)}
                    minLength={32}
                    maxLength={256}
                    autoComplete="new-password"
                    required
                  />
                  <FieldDescription>
                    At least 32 characters. It is encrypted and shown only once.
                  </FieldDescription>
                </Field>
              </FieldGroup>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button
                  onClick={() => void save()}
                  disabled={
                    pending ||
                    signingSecret.length < 32 ||
                    endpoint.length === 0
                  }
                >
                  {pending ? <Spinner data-icon="inline-start" /> : null}
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
            </div>
          </Field>
        </CardContent>
      </Card>
    </section>
  );
}

function detailLabel(value: DetailLevel): string {
  if (value === "privacy-minimal") return "Privacy-minimal";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
