import { z } from "zod";
import {
  clientTaskProfileSchema,
  localPolicySchema,
  taskClientToServerMessageSchema,
  taskServerToClientMessageSchema,
} from "./task.js";
import type {
  LocalPolicy,
  TaskClientToServerMessage,
  TaskServerToClientMessage,
} from "./task.js";

export * from "./task.js";

export const PROTOCOL_VERSION = 4;
export const DEFAULT_CLOUD_SERVER_URL = "https://server.odyshell.com";
export const MAX_CLIENT_CLOCK_SKEW_MILLISECONDS = 30_000;

export type HostPlatform = "linux" | "macos" | "windows";

export type ClientRuntimeInfo = {
  hostPlatform: HostPlatform;
  architecture: string;
  defaultShell: string;
  privilegeEscalation?: "none" | "sudo";
  nodeVersion: string;
  protocolVersion?: number;
  clientVersion?: string;
};

export const clientConfigSchema = z
  .object({
    serverUrl: z.string().url(),
    profileName: z.string().min(1).max(40).optional(),
    machineId: z.string().uuid(),
    machineName: z.string().min(1).max(128),
    privateKeyPem: z.string().min(1),
    stateDirectory: z.string().min(1).max(4096),
    taskProfile: z
      .object({
        id: z.string().trim().min(1).max(256),
        localPolicy: localPolicySchema,
      })
      .strict(),
  })
  .strict();
export type ClientConfig = z.infer<typeof clientConfigSchema>;

export type ServerToClientMessage =
  | TaskServerToClientMessage
  | { type: "challenge"; connectionId: string; nonce: string }
  | { type: "authenticated"; machineId: string }
  | {
      type: "error";
      code: "client_upgrade_required";
      message: string;
    }
  | { type: "ping"; pingId: string };

export type ClientToServerMessage =
  | TaskClientToServerMessage
  | {
      type: "authenticate";
      machineId: string;
      protocolVersion: number;
      signature: string;
      runtime?: ClientRuntimeInfo;
      taskProfile: {
        id: string;
        operatingSystemUser: string;
        localPolicy: LocalPolicy;
      };
    }
  | { type: "heartbeat"; machineId: string; at: string }
  | { type: "pong"; machineId: string; pingId: string };

const clientRuntimeInfoSchema = z
  .object({
    hostPlatform: z.enum(["linux", "macos", "windows"]),
    architecture: z.string().trim().min(1).max(64),
    defaultShell: z.string().trim().min(1).max(4096),
    privilegeEscalation: z.enum(["none", "sudo"]).optional(),
    nodeVersion: z.string().trim().min(1).max(64),
    protocolVersion: z.number().int().positive().optional(),
    clientVersion: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const clientControlMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("authenticate"),
      machineId: z.string().uuid(),
      protocolVersion: z.number().int().positive(),
      signature: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/),
      runtime: clientRuntimeInfoSchema.optional(),
      taskProfile: clientTaskProfileSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("heartbeat"),
      machineId: z.string().uuid(),
      at: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      type: z.literal("pong"),
      machineId: z.string().uuid(),
      pingId: z.string().uuid(),
    })
    .strict(),
]);

const serverControlMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("challenge"),
      connectionId: z.string().uuid(),
      nonce: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("authenticated"),
      machineId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.literal("client_upgrade_required"),
      message: z.string().trim().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      type: z.literal("ping"),
      pingId: z.string().uuid(),
    })
    .strict(),
]);

const clientMessageSchema = z.union([
  clientControlMessageSchema,
  taskClientToServerMessageSchema,
]);
const serverMessageSchema = z.union([
  serverControlMessageSchema,
  taskServerToClientMessageSchema,
]);

export function parseClientMessage(raw: string): ClientToServerMessage {
  return clientMessageSchema.parse(JSON.parse(raw)) as ClientToServerMessage;
}

export function parseServerMessage(raw: string): ServerToClientMessage {
  return serverMessageSchema.parse(JSON.parse(raw)) as ServerToClientMessage;
}
