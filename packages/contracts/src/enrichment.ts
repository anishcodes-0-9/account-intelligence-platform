import * as z from "zod/v4";

export const EnrichContactInputSchema = z.object({ contactId: z.string().min(1).max(100) });
export type EnrichContactInput = z.infer<typeof EnrichContactInputSchema>;

/** FAILED attempts are reported as PROVIDER_ERROR, never as a successful result. */
export const ENRICHMENT_RESULT_STATUSES = ["SUCCESS", "PARTIAL", "NOT_FOUND"] as const;

export const ProvenanceEntrySchema = z.object({
  field: z.enum(["email", "linkedin"]),
  source: z.string(),
  synthetic: z.boolean(),
  verified: z.boolean(),
  observedAt: z.iso.datetime(),
});
export type ProvenanceEntry = z.infer<typeof ProvenanceEntrySchema>;

/** `email` and `linkedin` are the assignment's fields; the rest is additive. */
export const EnrichContactOutputSchema = z.object({
  email: z.string().nullable(),
  linkedin: z.string().nullable(),
  status: z.enum(ENRICHMENT_RESULT_STATUSES),
  provider: z.string(),
  provenance: z.array(ProvenanceEntrySchema),
});
export type EnrichContactOutput = z.infer<typeof EnrichContactOutputSchema>;
