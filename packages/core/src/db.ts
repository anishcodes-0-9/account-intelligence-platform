import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

/** Prisma 7 requires a driver adapter; all callers go through this factory. */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export { PrismaClient };
export { Prisma, EnrichmentStatus } from "./generated/prisma/client.js";
export type {
  Company,
  Contact,
  EnrichmentRecord,
  ApiKey,
  ExportJob,
} from "./generated/prisma/client.js";
