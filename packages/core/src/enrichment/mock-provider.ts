import { createHash } from "node:crypto";
import type { ContactWithCompany } from "../repositories/contact-repository.js";

/** What a provider hands back. The service derives SUCCESS / PARTIAL / NOT_FOUND from which fields are present. */
export interface ProviderResult {
  email: string | null;
  linkedin: string | null;
}

/** Providers throw on failure; the service records that as FAILED and reports PROVIDER_ERROR. */
export interface EnrichmentProvider {
  readonly name: string;
  /** True when values are fabricated fixtures. Surfaced in provenance. Nothing is ever marked verified. */
  readonly synthetic: boolean;
  enrich(contact: ContactWithCompany): Promise<ProviderResult>;
}

export const MOCK_PROVIDER_NAME = "mock-synthetic";

export type MockOutcome = "SUCCESS" | "PARTIAL" | "NOT_FOUND" | "FAILED";

/** Deterministic from the contact id alone: 10% FAILED, 10% NOT_FOUND, 15% PARTIAL (email only), 65% SUCCESS. */
export function mockOutcomeFor(contactId: string): MockOutcome {
  const bucket = createHash("sha256").update(contactId).digest().readUInt32BE(0) % 20;
  if (bucket < 2) return "FAILED";
  if (bucket < 4) return "NOT_FOUND";
  if (bucket < 7) return "PARTIAL";
  return "SUCCESS";
}

const slug = (value: string): string =>
  value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Synthetic fixtures only; no network access. Every value uses a reserved name (RFC 2606): the company's
 * ".example" website host for email, `linkedin.example` with a "synthetic-" handle for LinkedIn.
 * Nothing returned here describes a real person.
 */
export class MockEnrichmentProvider implements EnrichmentProvider {
  readonly name = MOCK_PROVIDER_NAME;
  readonly synthetic = true;

  async enrich(contact: ContactWithCompany): Promise<ProviderResult> {
    const outcome = mockOutcomeFor(contact.id);
    if (outcome === "FAILED") throw new Error("mock provider: simulated upstream failure");
    if (outcome === "NOT_FOUND") return { email: null, linkedin: null };

    const person = [slug(contact.firstName), slug(contact.lastName)].filter(Boolean).join(".") || slug(contact.id);
    const host = new URL(contact.company.website).hostname;
    const email = `${person}@${host}`;
    if (outcome === "PARTIAL") return { email, linkedin: null };
    return { email, linkedin: `https://linkedin.example/in/synthetic-${person.replace(/\./g, "-")}-${slug(contact.id)}` };
  }
}
