import * as z from "zod/v4";

export const CONTACT_SEARCH_MAX_RESULTS = 100;

/** At least one of the two filters is required; blank strings count as "not provided". */
export const SearchContactsInputSchema = z.object({
  companyId: z.string().max(100).optional().describe("Company id, e.g. cmp_1."),
  jobTitle: z.string().max(100).optional().describe('Case-insensitive job title text, e.g. "Engineer".'),
});
export type SearchContactsInput = z.infer<typeof SearchContactsInputSchema>;

export const ContactSummarySchema = z.object({ id: z.string(), name: z.string(), title: z.string() });
export type ContactSummary = z.infer<typeof ContactSummarySchema>;

export const SearchContactsOutputSchema = z.object({ contacts: z.array(ContactSummarySchema) });
export type SearchContactsOutput = z.infer<typeof SearchContactsOutputSchema>;
