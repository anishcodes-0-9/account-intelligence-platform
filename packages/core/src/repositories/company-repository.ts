import type { Company, Prisma, PrismaClient } from "../db.js";

export interface CompanySearchParams {
  /** Every term must match (case-insensitive substring) in name, industry or description. */
  terms: string[];
  country?: string | undefined;
  /** Omit to return every match (the service applies whole-token matching, then its own limit). */
  limit?: number | undefined;
}

export class CompanyRepository {
  constructor(private readonly db: PrismaClient) {}

  create(data: Prisma.CompanyUncheckedCreateInput): Promise<Company> {
    return this.db.company.create({ data });
  }

  findById(id: string): Promise<Company | null> {
    return this.db.company.findUnique({ where: { id } });
  }

  search({ terms, country, limit }: CompanySearchParams): Promise<Company[]> {
    const where: Prisma.CompanyWhereInput = {
      AND: terms.map((term) => ({
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          { industry: { contains: term, mode: "insensitive" } },
          { description: { contains: term, mode: "insensitive" } },
        ],
      })),
    };
    if (country) where.country = { equals: country, mode: "insensitive" };
    return this.db.company.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      ...(limit !== undefined ? { take: limit } : {}),
    });
  }
}
