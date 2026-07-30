import { describe, expect, it } from "vitest";
import { deviceLoginUrl } from "../apps/cli/src/login.js";

describe("CLI browser login", () => {
  it("embeds only the human device code in the activation URL", () => {
    expect(
      deviceLoginUrl("https://odyshell.com/activate", "ABCD-EFGH"),
    ).toBe("https://odyshell.com/activate?code=ABCD-EFGH");
  });

  it("preserves a self-hosted path while replacing stale code parameters", () => {
    expect(
      deviceLoginUrl(
        "http://127.0.0.1:3000/base/activate?code=OLD&source=cli",
        "WXYZ-2345",
      ),
    ).toBe(
      "http://127.0.0.1:3000/base/activate?code=WXYZ-2345&source=cli",
    );
  });

  it("refuses non-web protocols returned by an untrusted server", () => {
    expect(() => deviceLoginUrl("file:///tmp/activate", "ABCD-EFGH")).toThrow(
      /HTTP or HTTPS/,
    );
    expect(() =>
      deviceLoginUrl("javascript:alert(1)", "ABCD-EFGH"),
    ).toThrow(/HTTP or HTTPS/);
  });
});
