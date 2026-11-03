import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Origin the `export_contacts` download URL is built on. Defaults to `http://<HOST>:<PORT>`. */
  DOWNLOAD_BASE_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof schema>;

/** Parses env once at startup and fails fast with a readable, secret-free message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}

/** `export_contacts`'s download URL origin: `DOWNLOAD_BASE_URL` if set, else derived from `HOST`/`PORT`. */
export function downloadBaseUrl(config: Config): string {
  return config.DOWNLOAD_BASE_URL ?? `http://${config.HOST}:${config.PORT}`;
}
