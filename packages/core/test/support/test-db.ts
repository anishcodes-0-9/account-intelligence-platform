import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";

const coreDir = fileURLToPath(new URL("../..", import.meta.url));

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}

export function baseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set (copy .env.example to .env and run `pnpm db:up`)");
  return url;
}

export function urlFor(database: string): string {
  const u = new URL(baseUrl());
  u.pathname = `/${database}`;
  return u.toString();
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor("postgres") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export const uniqueName = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`;

export function createDatabase(name: string, template?: string): Promise<void> {
  return admin(async (c) => {
    await c.query(`CREATE DATABASE ${ident(name)}${template ? ` TEMPLATE ${ident(template)}` : ""}`);
  });
}

export function dropDatabase(name: string): Promise<void> {
  return admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
  });
}

/** Runs the real migrations (`prisma migrate deploy`) against the given database url. */
export function prismaCli(args: string[], databaseUrl: string): string {
  return execFileSync("pnpm", ["exec", "prisma", ...args], {
    cwd: coreDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface IsolatedDb {
  prisma: PrismaClient;
  url: string;
  drop: () => Promise<void>;
}

/** Clones the pre-migrated template so each test file gets its own empty-but-migrated database. */
export async function createIsolatedDb(template: string): Promise<IsolatedDb> {
  const name = uniqueName("aip_test");
  await createDatabase(name, template);
  const url = urlFor(name);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  return {
    prisma,
    url,
    drop: async () => {
      await prisma.$disconnect();
      await dropDatabase(name);
    },
  };
}

export async function queryRows<T extends pg.QueryResultRow>(databaseUrl: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}
