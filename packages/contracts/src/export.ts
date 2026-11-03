import * as z from "zod/v4";

export const EXPORT_MAX_CONTACTS = 200;

export const ExportContactsInputSchema = z.object({
  contactIds: z.array(z.string().min(1).max(100)).min(1).max(EXPORT_MAX_CONTACTS),
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
