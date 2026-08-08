const MAX_COMMAND_OUTPUT_CHUNK_BYTES = 256 * 1024;
const standardBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function decodeCommandOutput(value: string): Buffer {
  if (
    value.length > 4 * Math.ceil(MAX_COMMAND_OUTPUT_CHUNK_BYTES / 3) ||
    !standardBase64Pattern.test(value)
  ) {
    throw new Error("Command output must be standard base64 within 256 KiB");
  }
  const output = Buffer.from(value, "base64");
  if (output.length > MAX_COMMAND_OUTPUT_CHUNK_BYTES) {
    throw new Error("Command output must be standard base64 within 256 KiB");
  }
  return output;
}
