import type { Readable } from "node:stream";

export const SPIKE_KEY = "spike-test-key-0123456789abcdef";

export async function collect(stream: Readable): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += String(chunk);
  return out;
}
