import type { TestProject } from "vitest/node";
import { createDatabase, dropDatabase, prismaCli, uniqueName, urlFor } from "./support/test-db.js";

/** Builds one template database from empty via the real migrations; test files clone it. */
export default async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
  const template = uniqueName("aip_template");
  await createDatabase(template);
  try {
    prismaCli(["migrate", "deploy"], urlFor(template));
  } catch (error) {
    await dropDatabase(template);
    throw error;
  }
  provide("templateDb", template);
  return () => dropDatabase(template);
}
