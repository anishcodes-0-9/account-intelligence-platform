import * as z from "zod/v4";

export const EXPORT_MAX_CONTACTS = 200;

/**
 * The business limit (EXPORT_MAX_CONTACTS, 200) is enforced by ExportService, not here, so an over-limit
 * request gets EXPORT_LIMIT rather than a generic VALIDATION_ERROR. The 1000 cap below is a much larger,
 * schema-level payload-size guard only -- it rejects obviously-abusive requests before they are parsed
 * into memory, and is not meant to communicate the 200 figure (the MCP tool schema does that).
 */
export const ExportContactsInputSchema = z.object({
  contactIds: z.array(z.string().min(1).max(100)).min(1).max(1000),
});
export type ExportContactsInput = z.infer<typeof ExportContactsInputSchema>;

/** `downloadUrl` is the assignment's field; the rest is additive. */
export const ExportContactsOutputSchema = z.object({
  downloadUrl: z.string(),
  exportId: z.string(),
  expiresAt: z.iso.datetime(),
  rowCount: z.number().int(),
});
export type ExportContactsOutput = z.infer<typeof ExportContactsOutputSchema>;
