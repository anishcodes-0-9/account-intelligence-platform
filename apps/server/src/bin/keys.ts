// API key administration: `pnpm keys create|list|revoke`. Raw keys are printed once, at creation only.
import { parseArgs } from "node:util";
import {
  ApiKeyRepository,
  ApiKeyService,
  createLogger,
  createPrismaClient,
  mapError,
  stderrDestination,
} from "@aip/core";
import { SCOPES } from "@aip/contracts";
import { loadConfig } from "../config.js";

const USAGE = `Usage:
  pnpm keys create --name <name> --scopes <scope[,scope...]> [--expires-in-days <n>]
  pnpm keys list
  pnpm keys revoke <keyId>

Scopes: ${SCOPES.join(", ")}
`;

const ARG_OPTIONS = {
  name: { type: "string" },
  scopes: { type: "string" },
  "expires-in-days": { type: "string" },
} as const;
type ArgOptions = typeof ARG_OPTIONS;

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}

const logger = createLogger({ destination: stderrDestination(), level: "error", name: "aip-keys" });
const out = (text: string): void => void process.stdout.write(`${text}\n`);
const fail = (text: string): never => {
  process.stderr.write(`${text}\n`);
  process.exit(1);
};

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs<{ allowPositionals: true; options: ArgOptions }>>;
  try {
    parsed = parseArgs({ allowPositionals: true, options: ARG_OPTIONS });
  } catch (error) {
    // Malformed command lines are user mistakes, not internal failures.
    return fail(`${error instanceof Error ? error.message : "Invalid arguments"}\n\n${USAGE}`);
  }
  const { positionals, values } = parsed;
  const [command, arg] = positionals;
  if (!command || !["create", "list", "revoke"].includes(command)) return fail(USAGE);

  const config = loadConfig();
  const db = createPrismaClient(config.DATABASE_URL);
  const service = new ApiKeyService(new ApiKeyRepository(db), { logger });
  try {
    if (command === "create") {
      let expiresAt: string | undefined;
      if (values["expires-in-days"] !== undefined) {
        const days = Number(values["expires-in-days"]);
        if (!Number.isFinite(days) || days <= 0) return fail("--expires-in-days must be a positive number");
        expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      }
      const { key, metadata } = await service.create({
        name: values.name,
        scopes: values.scopes?.split(",").map((s) => s.trim()).filter(Boolean),
        ...(expiresAt ? { expiresAt } : {}),
      });
      out(`Created API key ${metadata.id} (${metadata.name})`);
      out(`Scopes:  ${metadata.scopes.join(", ")}`);
      out(`Expires: ${metadata.expiresAt ?? "never"}`);
      out(`Key (shown only once, store it now): ${key}`);
    } else if (command === "list") {
      out(JSON.stringify(await service.list(), null, 2));
    } else {
      if (!arg) return fail(USAGE);
      const metadata = await service.revoke(arg);
      out(`Revoked API key ${metadata.id} (${metadata.name}) at ${metadata.revokedAt}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  const { body } = mapError(error, logger);
  process.stderr.write(`Error [${body.error.code}]: ${body.error.message}\n`);
  process.exit(1);
});
