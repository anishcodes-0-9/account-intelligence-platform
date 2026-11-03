import { createPrismaClient } from "../db.js";
import { seedDatabase } from "./seed.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required (copy .env.example to .env)\n");
  process.exit(1);
}

const db = createPrismaClient(url);
try {
  const result = await seedDatabase(db);
  process.stdout.write(`Seed complete: ${result.companies} companies, ${result.contacts} contacts\n`);
} finally {
  await db.$disconnect();
}
