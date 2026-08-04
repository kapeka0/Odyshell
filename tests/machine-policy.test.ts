import { describe, expect, it } from "vitest";
import {
  deniedMachineCapability,
  effectiveMachineCapabilities,
  machineLocalCapabilities,
  machineScopesAllowed,
} from "../apps/server/src/machine-policy.js";

const runtime = {
  profiles: [{
    name: "default",
    runner: "host",
    capabilities: ["fs.read", "fs.write", "host.shell", "not-real"],
  }],
};

describe("machine capability policy", () => {
  it("uses only protocol capabilities advertised by the Client", () => {
    expect(machineLocalCapabilities(runtime)).toEqual([
      "fs.read",
      "fs.write",
      "host.shell",
    ]);
  });

  it("lets the Server reduce but never expand the Client Local Policy", () => {
    expect(effectiveMachineCapabilities(runtime, ["fs.read", "docker.logs"]))
      .toEqual(["fs.read"]);
    expect(effectiveMachineCapabilities(runtime, null)).toEqual([
      "fs.read",
      "fs.write",
      "host.shell",
    ]);
    expect(deniedMachineCapability(runtime, ["fs.read", "docker.logs"]))
      .toBe("docker.logs");
  });

  it("fails closed when a Session asks for a disabled capability", () => {
    const machine = {
      id: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
      runtime,
      capabilityPolicy: ["fs.read"],
    };
    expect(machineScopesAllowed([machine], [{
      machineId: machine.id,
      profile: "default",
      capabilities: ["fs.read"],
      restrictions: {},
    }])).toBe(true);
    expect(machineScopesAllowed([machine], [{
      machineId: machine.id,
      profile: "default",
      capabilities: ["fs.write"],
      restrictions: {},
    }])).toBe(false);
    expect(machineScopesAllowed([{ ...machine, capabilityPolicy: null }], [{
      machineId: machine.id,
      profile: "default",
      capabilities: ["docker.logs"],
      restrictions: {},
    }])).toBe(true);
  });

  it("rejects Host Shell structurally for Docker Profiles without a Server policy", () => {
    const machineId = "2dc24de7-ec0e-45b3-88c1-acbb900e51f8";
    const dockerRuntime = {
      profiles: [{
        name: "workspace",
        runner: "docker",
        // A compromised or stale advertisement must not turn a capability
        // bit into native host authority for a Docker Profile.
        capabilities: ["fs.read", "host.shell"],
      }],
    };

    expect(machineScopesAllowed([{
      id: machineId,
      runtime: dockerRuntime,
      capabilityPolicy: null,
    }], [{
      machineId,
      profile: "workspace",
      capabilities: ["host.shell"],
      restrictions: {},
    }])).toBe(false);
  });
});
