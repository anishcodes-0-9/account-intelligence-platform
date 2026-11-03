import {
  COMPANY_SEARCH_DEFAULT_LIMIT,
  GetCompanyInputSchema,
  SearchCompaniesInputSchema,
  type CompanyDetail,
  type CompanySummary,
  type SearchCompaniesOutput,
} from "@aip/contracts";
import type { AuthPrincipal } from "../auth/principal.js";
import { requireScope } from "../auth/principal.js";
import type { Company } from "../db.js";
import { NotFoundError } from "../errors/app-error.js";
import { blankToUndefined, parseInput } from "../errors/parse-input.js";
import type { CompanyRepository } from "../repositories/company-repository.js";
import { matchesAllTokens, parseSearchQuery } from "./search-query.js";

const toSummary = (c: Company): CompanySummary => ({ id: c.id, name: c.name, industry: c.industry, employees: c.employees });

const toDetail = (c: Company): CompanyDetail => ({
  id: c.id,
  name: c.name,
  website: c.website,
  industry: c.industry,
  employees: c.employees,
  description: c.description,
  country: c.country,
});

export class CompanyService {
  constructor(private readonly companies: CompanyRepository) {}

  async search(principal: AuthPrincipal, rawInput: unknown): Promise<SearchCompaniesOutput> {
    requireScope(principal, "companies:read");
    // The shared schema enforces limit 1..50 here, so the bound holds regardless of the calling transport.
    const input = parseInput(SearchCompaniesInputSchema, rawInput);
    const tokens = parseSearchQuery(input.query);
    const limit = input.limit ?? COMPANY_SEARCH_DEFAULT_LIMIT;
    const country = blankToUndefined(input.country);

    // The database narrows by substring (a superset of whole-token matches); whole-token matching and the limit
    // are applied afterwards, so no row is dropped by a limit that the token filter would later have rejected.
    const candidates = await this.companies.search({ terms: tokens, country });
    const matches = tokens.length
      ? candidates.filter((c) => matchesAllTokens([c.name, c.industry, c.description], tokens))
      : candidates;
    return { results: matches.slice(0, limit).map(toSummary) };
  }

  async getById(principal: AuthPrincipal, rawInput: unknown): Promise<CompanyDetail> {
    requireScope(principal, "companies:read");
    const { companyId } = parseInput(GetCompanyInputSchema, rawInput);
    const company = await this.companies.findById(companyId);
    if (!company) throw new NotFoundError(`Company not found: ${companyId}`);
    return toDetail(company);
  }
}
