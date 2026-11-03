// M7 demonstration script: a real MCP client (the official MCP TypeScript SDK's own `Client`, the same
// one `docs/mcp-server.md` already documents as "tested against" and `rest-mcp-parity.test.ts` already
// uses) driving the running AIP server end to end, over real Streamable HTTP, with real network calls.
//
// This is not a test: there are no assertions and no throwaway database. It connects to whatever server
// is already listening at the configured HOST/PORT (see docs/demo/README.md for the exact setup), and it
// writes real evidence -- JSON and a real downloaded CSV -- to docs/demo/evidence/.
//
// The only service-level (non-MCP) calls here are api-key provisioning (ApiKeyService.create/revoke),
// used identically to how `pnpm keys create`/`pnpm keys revoke` already manage keys from the command line
// -- never to perform the demonstrated business operations themselves, which all go through the MCP
// client and the real /mcp route.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@aip/core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { downloadBaseUrl, loadConfig } from "../src/config.js";
import { buildServices } from "../src/mcp/services.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(here, "../../../docs/demo/evidence");

async function saveJson(name: string, data: unknown): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`-> wrote docs/demo/evidence/${name}`);
}

async function saveText(name: string, text: string): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, name), text, "utf8");
  console.log(`-> wrote docs/demo/evidence/${name}`);
}

/** Redacts everything but the key's non-secret id segment, so evidence files never carry a usable credential. */
function redactKey(rawKey: string): string {
  const match = /^aip_([a-z0-9]+)_/.exec(rawKey);
  return match ? `aip_${match[1]}_***redacted***` : "***redacted***";
}

/**
 * The download token is itself a credential (CLAUDE.md: "never log them or store the raw token"; the
 * real request logger scrubs `/downloads/<token>` the same way -- see `packages/core/src/logging/
 * logger.ts`'s `DOWNLOAD_URL_PATTERN`). This script fetches the real URL to verify the CSV, but never
 * prints or saves it unredacted.
 */
function redactDownloadUrl(url: string): string {
  return url.replace(/\/downloads\/[A-Za-z0-9_-]{20,}/, "/downloads/***redacted***");
}

function connect(baseUrl: string, apiKey?: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
    requestInit: apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {},
  });
  const client = new Client({ name: "aip-m7-demo", version: "1.0.0" });
  return { client, transport };
}

/** Bounded concurrency: the orchestration layer (this script), not the MCP protocol, enforces the limit. */
class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];
  public maxObservedInFlight = 0;
  private inFlight = 0;

  constructor(private readonly limit: number) {
    this.available = limit;
  }

  /** Live, instantaneous count -- read by the sampler below while calls are actually running. */
  get currentInFlight(): number {
    return this.inFlight;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available === 0) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.available--;
    }
    this.inFlight++;
    this.maxObservedInFlight = Math.max(this.maxObservedInFlight, this.inFlight);
    try {
      return await fn();
    } finally {
      this.inFlight--;
      const next = this.queue.shift();
      if (next) next();
      else this.available++;
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const baseUrl = downloadBaseUrl(config);
  const logger = createLogger({ level: "silent" });
  const { db, services } = buildServices({ databaseUrl: config.DATABASE_URL, downloadBaseUrl: baseUrl, logger });

  console.log(`Connecting to AIP server at ${baseUrl} (/mcp, /downloads)\n`);

  // --- Provision demo API keys (same ApiKeyService `pnpm keys create`/`revoke` already use) ---
  const full = await services.apiKeys.create({ name: `m7-demo-full-${Date.now()}`, scopes: ["companies:read", "contacts:read", "contacts:enrich", "contacts:export"] });
  const companiesOnly = await services.apiKeys.create({ name: `m7-demo-companies-only-${Date.now()}`, scopes: ["companies:read"] });
  const toRevoke = await services.apiKeys.create({ name: `m7-demo-to-revoke-${Date.now()}`, scopes: ["companies:read", "contacts:read"] });
  await services.apiKeys.revoke(toRevoke.metadata.id);
  const expiring = await services.apiKeys.create({ name: `m7-demo-expiring-${Date.now()}`, scopes: ["companies:read"], expiresAt: new Date(Date.now() + 1500).toISOString() });
  console.log("Provisioned demo keys:", {
    full: redactKey(full.key),
    companiesOnly: redactKey(companiesOnly.key),
    revoked: redactKey(toRevoke.key),
    expiring: redactKey(expiring.key),
  });
  console.log("Waiting for the 'expiring' key to actually expire...");
  await new Promise((r) => setTimeout(r, 2000));

  // ============================================================================================
  // 1. Connection, initialization and tool discovery
  // ============================================================================================
  const { client: fullClient, transport: fullTransport } = connect(baseUrl, full.key);
  await fullClient.connect(fullTransport);
  const { tools } = await fullClient.listTools();
  console.log(`\nConnected and initialized. Discovered ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
  await saveJson("02-connect-and-discover.json", {
    serverUrl: `${baseUrl}/mcp`,
    transport: "StreamableHTTPClientTransport (@modelcontextprotocol/client)",
    toolCount: tools.length,
    tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })),
  });

  // ============================================================================================
  // 2. Authentication failures: missing / malformed / expired / revoked keys
  // ============================================================================================
  async function attemptConnect(label: string, apiKey?: string): Promise<{ label: string; outcome: string; detail: string }> {
    const { client, transport } = connect(baseUrl, apiKey);
    try {
      await client.connect(transport);
      await client.listTools();
      await client.close();
      return { label, outcome: "UNEXPECTED SUCCESS", detail: "" };
    } catch (error) {
      return { label, outcome: "rejected", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const authFailures = await Promise.all([
    attemptConnect("missing Authorization header", undefined),
    attemptConnect("malformed/garbage API key", "aip_garbage_notreal"),
    attemptConnect("expired API key", expiring.key),
    attemptConnect("revoked API key", toRevoke.key),
  ]);
  console.log("\nAuthentication failure evidence:");
  for (const f of authFailures) console.log(`  - ${f.label}: ${f.outcome}`);
  await saveJson("03-auth-failures.json", authFailures);

  // ============================================================================================
  // 3. Scope enforcement: a valid key lacking contacts:export tries export_contacts
  // ============================================================================================
  const { client: scopedClient, transport: scopedTransport } = connect(baseUrl, companiesOnly.key);
  await scopedClient.connect(scopedTransport);
  const forbiddenResult = await scopedClient.callTool({ name: "export_contacts", arguments: { contactIds: ["cnt_1"] } });
  await scopedClient.close();
  console.log("\nScope enforcement (companies:read-only key calling export_contacts):", JSON.stringify(forbiddenResult.structuredContent));
  await saveJson("04-scope-forbidden.json", { tool: "export_contacts", keyScopes: companiesOnly.metadata.scopes, isError: forbiddenResult.isError, structuredContent: forbiddenResult.structuredContent });

  // ============================================================================================
  // 4. End-to-end workflow against real seeded data
  // ============================================================================================
  console.log("\n--- End-to-end workflow ---");
  const search = await fullClient.callTool({ name: "search_companies", arguments: { query: "Intelligence", country: "Australia", limit: 10 } });
  const searchData = search.structuredContent as { results: Array<{ id: string; name: string; industry: string; employees: number }> };
  console.log(`1. search_companies(query="Intelligence", country="Australia") -> ${searchData.results.length} result(s)`);
  if (searchData.results.length === 0) throw new Error("demo precondition failed: expected at least one AI company in Australia in seed data");
  const targetCompany = searchData.results[0]!;

  const company = await fullClient.callTool({ name: "get_company", arguments: { companyId: targetCompany.id } });
  console.log(`2. get_company(${targetCompany.id}) -> ${JSON.stringify(company.structuredContent)}`);

  const contactsRes = await fullClient.callTool({ name: "search_contacts", arguments: { companyId: targetCompany.id } });
  const contactsData = contactsRes.structuredContent as { contacts: Array<{ id: string; name: string; title: string }> };
  console.log(`3. search_contacts(companyId=${targetCompany.id}) -> ${contactsData.contacts.length} contact(s)`);
  const toEnrich = contactsData.contacts.slice(0, 2);

  const enriched = [];
  for (const contact of toEnrich) {
    const result = await fullClient.callTool({ name: "enrich_contact", arguments: { contactId: contact.id } });
    console.log(`4. enrich_contact(${contact.id}) -> ${JSON.stringify(result.structuredContent)}`);
    enriched.push({ contactId: contact.id, result: result.structuredContent });
  }

  const exportRes = await fullClient.callTool({ name: "export_contacts", arguments: { contactIds: toEnrich.map((c) => c.id) } });
  const exportData = exportRes.structuredContent as { downloadUrl: string; exportId: string; expiresAt: string; rowCount: number };
  console.log(`5. export_contacts(${toEnrich.map((c) => c.id).join(", ")}) -> rowCount=${exportData.rowCount}, expiresAt=${exportData.expiresAt}`);

  const csvResponse = await fetch(exportData.downloadUrl);
  const csvText = await csvResponse.text();
  const csvLines = csvText.trim().split("\r\n");
  const header = csvLines[0];
  const dataLines = csvLines.slice(1);
  console.log(`6. GET ${redactDownloadUrl(exportData.downloadUrl)} -> ${csvResponse.status}, header="${header}", ${dataLines.length} data row(s) (rowCount=${exportData.rowCount})`);
  if (csvResponse.status !== 200) throw new Error(`unexpected download status ${csvResponse.status}`);
  if (header !== "id,name,title,email,linkedin") throw new Error(`unexpected CSV header: ${header}`);
  if (dataLines.length !== exportData.rowCount) throw new Error(`CSV row count ${dataLines.length} does not match reported rowCount ${exportData.rowCount}`);
  for (const contact of toEnrich) {
    if (!dataLines.some((line) => line.startsWith(`${contact.id},`))) throw new Error(`exported CSV missing row for ${contact.id}`);
  }

  await saveText("export.csv", csvText);
  await saveJson("05-end-to-end-workflow.json", {
    step1_search_companies: { input: { query: "Intelligence", country: "Australia", limit: 10 }, output: searchData },
    step2_get_company: { input: { companyId: targetCompany.id }, output: company.structuredContent },
    step3_search_contacts: { input: { companyId: targetCompany.id }, output: contactsData },
    step4_enrich_contact: enriched,
    step5_export_contacts: { input: { contactIds: toEnrich.map((c) => c.id) }, output: { ...exportData, downloadUrl: redactDownloadUrl(exportData.downloadUrl) } },
    step6_download: { url: redactDownloadUrl(exportData.downloadUrl), status: csvResponse.status, contentType: csvResponse.headers.get("content-type"), header, rowCount: dataLines.length, matchesReportedRowCount: dataLines.length === exportData.rowCount },
  });
  console.log("End-to-end workflow verified: CSV headers, row count and contact ids all match.");

  // ============================================================================================
  // 4b. Clean happy path: a guaranteed-successful enrichment, export and verified download
  //
  // The step above intentionally kept a real PROVIDER_ERROR as error-handling evidence. This step
  // uses two seeded contact ids whose outcome is deterministic from the mock provider's own logic
  // (`mockOutcomeFor` hashes the contact id -- see packages/core/src/enrichment/mock-provider.ts) and
  // is independently verified at runtime below, rather than assumed: if seed data or provider
  // behavior ever changes so these ids stop succeeding, this step fails loudly instead of silently
  // passing. The provider itself is never modified to force this outcome.
  // ============================================================================================
  console.log("\n--- Clean happy path (guaranteed successful enrichment) ---");
  const HAPPY_PATH_CONTACT_IDS = ["cnt_17", "cnt_19"]; // cmp_5's contacts; both deterministically SUCCESS
  const happyEnriched: Array<{ contactId: string; result: unknown }> = [];
  for (const contactId of HAPPY_PATH_CONTACT_IDS) {
    const result = await fullClient.callTool({ name: "enrich_contact", arguments: { contactId } });
    const data = result.structuredContent as { status: string; email: string | null; linkedin: string | null; provenance: Array<{ synthetic: boolean; verified: boolean }> };
    console.log(`enrich_contact(${contactId}) -> ${JSON.stringify(data)}`);
    if (data.status !== "SUCCESS") throw new Error(`happy-path precondition failed: expected SUCCESS for ${contactId}, got ${data.status} -- seed data or provider behavior changed`);
    if (!data.email || !data.linkedin) throw new Error(`happy-path contact ${contactId}: SUCCESS but missing email/linkedin`);
    if (!data.provenance.every((p) => p.synthetic === true && p.verified === false)) {
      throw new Error(`happy-path contact ${contactId}: enrichment provenance not labelled synthetic/unverified`);
    }
    happyEnriched.push({ contactId, result: data });
  }

  const happyExportRes = await fullClient.callTool({ name: "export_contacts", arguments: { contactIds: HAPPY_PATH_CONTACT_IDS } });
  const happyExportData = happyExportRes.structuredContent as { downloadUrl: string; exportId: string; expiresAt: string; rowCount: number };
  console.log(`export_contacts(${HAPPY_PATH_CONTACT_IDS.join(", ")}) -> rowCount=${happyExportData.rowCount}`);

  const happyCsvResponse = await fetch(happyExportData.downloadUrl);
  const happyCsvText = await happyCsvResponse.text();
  const happyCsvLines = happyCsvText.trim().split("\r\n");
  const happyHeader = happyCsvLines[0];
  const happyDataLines = happyCsvLines.slice(1);
  console.log(`GET ${redactDownloadUrl(happyExportData.downloadUrl)} -> ${happyCsvResponse.status}, ${happyDataLines.length} data row(s)`);
  if (happyCsvResponse.status !== 200) throw new Error(`unexpected happy-path download status ${happyCsvResponse.status}`);
  if (happyHeader !== "id,name,title,email,linkedin") throw new Error(`unexpected happy-path CSV header: ${happyHeader}`);
  if (happyDataLines.length !== happyExportData.rowCount) throw new Error(`happy-path CSV row count ${happyDataLines.length} does not match reported rowCount ${happyExportData.rowCount}`);
  for (const contactId of HAPPY_PATH_CONTACT_IDS) {
    const row = happyDataLines.find((line) => line.startsWith(`${contactId},`));
    if (!row) throw new Error(`happy-path CSV missing row for ${contactId}`);
    const fields = row.split(",");
    if (!fields[3] || !fields[4]) throw new Error(`happy-path CSV row for ${contactId} has empty email/linkedin: ${row}`);
  }
  await saveText("happy-path-export.csv", happyCsvText);
  await saveJson("05b-happy-path-workflow.json", {
    note: "Deterministic SUCCESS-outcome contacts, verified at runtime (not assumed); the mock provider was not modified.",
    step1_enrich_contact: happyEnriched,
    step2_export_contacts: { input: { contactIds: HAPPY_PATH_CONTACT_IDS }, output: { ...happyExportData, downloadUrl: redactDownloadUrl(happyExportData.downloadUrl) } },
    step3_download: { url: redactDownloadUrl(happyExportData.downloadUrl), status: happyCsvResponse.status, header: happyHeader, rowCount: happyDataLines.length, rows: happyDataLines },
  });
  console.log("Happy-path workflow verified: both enrichments SUCCESS, synthetic/unverified, and present with real values in the downloaded CSV.");

  // ============================================================================================
  // 5. Bounded parallel execution
  // ============================================================================================
  console.log("\n--- Bounded concurrency demo (limit = 3) ---");
  const CONCURRENCY_LIMIT = 3;
  const sem = new Semaphore(CONCURRENCY_LIMIT);
  const targetIds = Array.from({ length: 6 }, (_, i) => `cmp_${i + 1}`);
  const timeline: Array<{ companyId: string; startMs: number; endMs: number }> = [];

  // Live sampler: polls the semaphore's *actual* in-flight counter every ~1ms while calls are
  // running, so "overlap" is observed directly during execution, not just inferred afterwards from
  // start/end deltas. A sample of 2 or 3 is only possible if that many calls are genuinely awaiting
  // their network round trip at the same instant.
  const inFlightSamples: number[] = [];
  const samplerHandle = setInterval(() => inFlightSamples.push(sem.currentInFlight), 1);

  const t0 = Date.now();
  await Promise.all(
    targetIds.map((companyId) =>
      sem.run(async () => {
        const startMs = Date.now() - t0;
        await fullClient.callTool({ name: "get_company", arguments: { companyId } });
        const endMs = Date.now() - t0;
        timeline.push({ companyId, startMs, endMs });
      }),
    ),
  );
  clearInterval(samplerHandle);

  timeline.sort((a, b) => a.startMs - b.startMs);
  const overlapsExist = timeline.some((a, i) => timeline.some((b, j) => i !== j && a.startMs < b.endMs && b.startMs < a.endMs));
  const sampledMaxInFlight = inFlightSamples.length ? Math.max(...inFlightSamples) : 0;
  const samplesAtTwoOrMore = inFlightSamples.filter((n) => n >= 2).length;
  const samplesAtLimit = inFlightSamples.filter((n) => n === CONCURRENCY_LIMIT).length;
  console.log(`Ran ${targetIds.length} independent get_company calls (different companyIds -> no shared state, safe to parallelize), bounded to ${CONCURRENCY_LIMIT} in flight at once.`);
  console.log(`Max observed in-flight (semaphore's own counter, after each call): ${sem.maxObservedInFlight}`);
  console.log(`Live sampler: ${inFlightSamples.length} samples taken during execution; max sampled in-flight = ${sampledMaxInFlight}; ${samplesAtTwoOrMore} sample(s) at >=2, ${samplesAtLimit} sample(s) exactly at the limit (${CONCURRENCY_LIMIT}).`);
  console.log(`Overlapping execution observed (from start/end timestamps): ${overlapsExist}`);
  for (const t of timeline) console.log(`  ${t.companyId}: start=${t.startMs}ms end=${t.endMs}ms`);
  if (sem.maxObservedInFlight > CONCURRENCY_LIMIT) throw new Error(`semaphore violated its own limit: observed ${sem.maxObservedInFlight} > ${CONCURRENCY_LIMIT}`);
  await saveJson("06-bounded-concurrency.json", {
    concurrencyLimit: CONCURRENCY_LIMIT,
    operation: "get_company",
    independentInputs: targetIds,
    rationale: "Each call reads a different companyId with no shared mutable state, so the calls are safe to run concurrently; the client (this script's own Semaphore), not the MCP protocol, enforces the limit of 3 in flight at once.",
    maxObservedInFlight: sem.maxObservedInFlight,
    overlappingExecutionObserved: overlapsExist,
    timelineMs: timeline,
    liveSampler: {
      description: "sem.currentInFlight polled every ~1ms for the duration of the concurrent run -- a direct, live observation of overlap, not one reconstructed from start/end timestamps after the fact.",
      sampleCount: inFlightSamples.length,
      maxSampledInFlight: sampledMaxInFlight,
      samplesAtTwoOrMore,
      samplesAtLimit,
      samples: inFlightSamples,
    },
  });

  await fullClient.close();
  await db.$disconnect();
  console.log("\nDemo complete.");
}

main().catch((error: unknown) => {
  console.error("demo failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
