import { describe, expect, it } from "vitest";
import { isContainerAlreadyRemoved } from "../apps/client/src/docker-runner.js";

describe("DockerRunner cleanup", () => {
  it("treats an absent container as an idempotent close", () => {
    expect(
      isContainerAlreadyRemoved(
        new Error("Error response from daemon: No such container: odyshell-session"),
      ),
    ).toBe(true);
  });

  it("treats concurrent Docker removal as an idempotent close", () => {
    expect(
      isContainerAlreadyRemoved(
        new Error(
          "Error response from daemon: removal of container odyshell-session is already in progress",
        ),
      ),
    ).toBe(true);
  });

  it("does not hide unrelated Docker failures", () => {
    expect(
      isContainerAlreadyRemoved(
        new Error("permission denied while trying to connect to the Docker daemon"),
      ),
    ).toBe(false);
  });
});
