"use client";

import { useEffect, useState } from "react";
import { WebhookIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
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
    <Card>
      <CardHeader>
        <CardTitle>Event Sink</CardTitle>
        <CardDescription>Signed Timeline delivery.</CardDescription>
        <CardAction>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button variant="outline" />}>
              <WebhookIcon data-icon="inline-start" />
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
                </Field>
                <Field>
                  <FieldLabel htmlFor="sink-detail">Detail</FieldLabel>
                  <Select
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
                        <SelectItem value="privacy-minimal">
                          Privacy-minimal
                        </SelectItem>
                        <SelectItem value="operational">
                          Operational
                        </SelectItem>
                        <SelectItem value="diagnostic">
                          Diagnostic
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
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
        </CardAction>
      </CardHeader>
      <CardContent className="flex items-center gap-3">
        {sink ? (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{sink.endpoint}</p>
              <p className="text-sm text-muted-foreground">
                Secret {sink.signingSecret}
              </p>
            </div>
            <Badge variant="outline">{detailLabel(sink.detailLevel)}</Badge>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Not configured.</p>
        )}
      </CardContent>
    </Card>
  );
}

function detailLabel(value: DetailLevel): string {
  if (value === "privacy-minimal") return "Privacy-minimal";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
