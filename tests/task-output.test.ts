import { describe, expect, it } from "vitest";
import { decodeCommandOutput } from "../apps/server/src/task-output.js";

describe("Command output boundary", () => {
  it("accepts standard base64 up to one transport chunk", () => {
    const output = Buffer.alloc(256 * 1024, 7);
    expect(decodeCommandOutput(output.toString("base64"))).toEqual(output);
  });

  it.each(["not base64!", "YQ", Buffer.alloc(256 * 1024 + 1).toString("base64")])(
    "rejects malformed or oversized Client output",
    (input) => expect(() => decodeCommandOutput(input)).toThrow(/256 KiB/),
  );
});
