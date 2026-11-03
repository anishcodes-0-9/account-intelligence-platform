import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/generated/prisma/client.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}

const url = process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }) : undefined;

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("Prisma 7 + driver adapter -> Docker Postgres", () => {
  it("connects and runs a query", async () => {
    expect(prisma, "DATABASE_URL must be set (copy .env.example to .env)").toBeDefined();
    const rows = await prisma!.$queryRaw<{ ok: number; db: string }[]>`SELECT 1 AS ok, current_database() AS db`;
    expect(rows[0]).toEqual({ ok: 1, db: "aip" });
  });
});
