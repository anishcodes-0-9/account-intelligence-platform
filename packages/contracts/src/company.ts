import * as z from "zod/v4";

export const COMPANY_SEARCH_DEFAULT_LIMIT = 10;
export const COMPANY_SEARCH_MAX_LIMIT = 50;

/** Blank `query` / `country` are treated as "not provided" by the service. */
export const SearchCompaniesInputSchema = z.object({
  query: z.string().max(200).optional().describe('Free-text terms, e.g. "AI companies". Every term must match a whole word in name, industry or description.'),
  country: z.string().max(100).optional().describe("Exact country name, case-insensitive, e.g. Australia."),
  limit: z.number().int().min(1).max(COMPANY_SEARCH_MAX_LIMIT).optional().describe(`Max results (default ${COMPANY_SEARCH_DEFAULT_LIMIT}, max ${COMPANY_SEARCH_MAX_LIMIT}).`),
});
export type SearchCompaniesInput = z.infer<typeof SearchCompaniesInputSchema>;

export const CompanySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  industry: z.string(),
  employees: z.number().int(),
});
export type CompanySummary = z.infer<typeof CompanySummarySchema>;

export const SearchCompaniesOutputSchema = z.object({ results: z.array(CompanySummarySchema) });
export type SearchCompaniesOutput = z.infer<typeof SearchCompaniesOutputSchema>;

export const GetCompanyInputSchema = z.object({ companyId: z.string().min(1).max(100) });
export type GetCompanyInput = z.infer<typeof GetCompanyInputSchema>;

/** Assignment fields plus `country` (additive). */
export const CompanyDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string(),
  industry: z.string(),
  employees: z.number().int(),
  description: z.string(),
  country: z.string(),
});
export type CompanyDetail = z.infer<typeof CompanyDetailSchema>;
