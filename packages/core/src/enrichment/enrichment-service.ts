import {
  EnrichContactInputSchema,
  type EnrichContactOutput,
  type ProvenanceEntry,
} from "@aip/contracts";
import { requireScope, type AuthPrincipal } from "../auth/principal.js";
import type { PrismaClient } from "../db.js";
import { NotFoundError, ProviderError } from "../errors/app-error.js";
import { parseInput } from "../errors/parse-input.js";
import type { Logger } from "../logging/logger.js";
import { ContactRepository } from "../repositories/contact-repository.js";
import { EnrichmentRepository } from "../repositories/enrichment-repository.js";
import type { EnrichmentProvider, ProviderResult } from "./mock-provider.js";
import { sanitizeProviderError } from "./sanitize-error.js";

export interface EnrichmentServiceOptions {
  now?: () => Date;
  logger?: Logger;
}

function statusFor({ email, linkedin }: ProviderResult): EnrichContactOutput["status"] {
  if (email && linkedin) return "SUCCESS";
  return email || linkedin ? "PARTIAL" : "NOT_FOUND";
}

export class EnrichmentService {
  private readonly contacts: ContactRepository;
  private readonly enrichments: EnrichmentRepository;
  private readonly now: () => Date;
  private readonly logger: Logger | undefined;

  /**
   * Takes the raw PrismaClient (not pre-built repositories) so the SUCCESS/PARTIAL write below can run
   * both statements through one `$transaction` and stay genuinely atomic: two repositories built from
   * two different client instances would not share a transaction even if a caller wrapped them in one.
   */
  constructor(
    private readonly db: PrismaClient,
    private readonly provider: EnrichmentProvider,
    options: EnrichmentServiceOptions = {},
  ) {
    this.contacts = new ContactRepository(db);
    this.enrichments = new EnrichmentRepository(db);
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  /**
   * Every call asks the provider again and writes a new EnrichmentRecord, including repeats and failures.
   * Contact.email / linkedin only change for fields this attempt returned, so the latest successful value is kept.
   * The result reports what this attempt returned, not the merged contact.
   */
  async enrich(principal: AuthPrincipal, rawInput: unknown): Promise<EnrichContactOutput> {
    requireScope(principal, "contacts:enrich");
    const { contactId } = parseInput(EnrichContactInputSchema, rawInput);
    const contact = await this.contacts.findById(contactId);
    if (!contact) throw new NotFoundError(`Contact not found: ${contactId}`);

    const provider = this.provider.name;
    let result: ProviderResult;
    try {
      // Outside the transaction: an external provider call has no place holding a DB transaction open.
      result = await this.provider.enrich(contact);
    } catch (cause) {
      await this.enrichments.create({
        contactId,
        provider,
        status: "FAILED",
        returned: {},
        provenance: [],
        error: sanitizeProviderError(cause),
      });
      this.logger?.warn({ contactId, provider, keyId: principal.keyId, status: "FAILED" }, "enrichment failed");
      // The raw cause is logged by mapError and never sent to the client; its message is never logged here.
      throw new ProviderError("Enrichment provider failed", { cause });
    }

    const email = result.email || null;
    const linkedin = result.linkedin || null;
    const status = statusFor({ email, linkedin });
    const observedAt = this.now().toISOString();
    // Provenance covers the fields this attempt supplied; the record's provider/status/createdAt describe the attempt itself.
    const provenance: ProvenanceEntry[] = (["email", "linkedin"] as const)
      .filter((field) => (field === "email" ? email : linkedin) !== null)
      .map((field) => ({ field, source: provider, synthetic: this.provider.synthetic, verified: false, observedAt }));

    if (email || linkedin) {
      // SUCCESS/PARTIAL: the record and the contact update must land together or not at all.
      await this.db.$transaction(async (tx) => {
        const txEnrichments = new EnrichmentRepository(tx);
        const txContacts = new ContactRepository(tx);
        await txEnrichments.create({ contactId, provider, status, returned: { email, linkedin }, provenance });
        await txContacts.updateEnrichedFields(contactId, {
          ...(email ? { email } : {}),
          ...(linkedin ? { linkedin } : {}),
        });
      });
    } else {
      // NOT_FOUND: a single write, nothing to keep atomic with, and the contact is never touched.
      await this.enrichments.create({ contactId, provider, status, returned: { email, linkedin }, provenance });
    }
    this.logger?.info({ contactId, provider, keyId: principal.keyId, status }, "enrichment completed");
    return { email, linkedin, status, provider, provenance };
  }
}
