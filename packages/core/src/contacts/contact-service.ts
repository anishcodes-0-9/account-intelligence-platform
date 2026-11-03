import {
  CONTACT_SEARCH_MAX_RESULTS,
  SearchContactsInputSchema,
  type SearchContactsOutput,
} from "@aip/contracts";
import { requireScope, type AuthPrincipal } from "../auth/principal.js";
import { NotFoundError, ValidationError } from "../errors/app-error.js";
import { blankToUndefined, parseInput } from "../errors/parse-input.js";
import type { CompanyRepository } from "../repositories/company-repository.js";
import type { ContactRepository } from "../repositories/contact-repository.js";

export class ContactService {
  constructor(
    private readonly contacts: ContactRepository,
    private readonly companies: CompanyRepository,
  ) {}

  async search(principal: AuthPrincipal, rawInput: unknown): Promise<SearchContactsOutput> {
    requireScope(principal, "contacts:read");
    const input = parseInput(SearchContactsInputSchema, rawInput);
    const companyId = blankToUndefined(input.companyId);
    const jobTitle = blankToUndefined(input.jobTitle);
    if (!companyId && !jobTitle) throw new ValidationError("at least one of companyId or jobTitle is required");

    if (companyId && !(await this.companies.findById(companyId))) {
      throw new NotFoundError(`Company not found: ${companyId}`);
    }
    const rows = await this.contacts.search({ companyId, jobTitle, limit: CONTACT_SEARCH_MAX_RESULTS });
    // Database field names (fullName, jobTitle) are mapped to the assignment's public names (name, title).
    return { contacts: rows.map((c) => ({ id: c.id, name: c.fullName, title: c.jobTitle })) };
  }
}
