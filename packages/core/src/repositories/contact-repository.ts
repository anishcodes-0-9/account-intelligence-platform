import type { Company, Contact, Prisma, PrismaClient } from "../db.js";

export type ContactWithCompany = Contact & { company: Company };

export interface ContactSearchParams {
  companyId?: string | undefined;
  /** Case-insensitive substring match on jobTitle. */
  jobTitle?: string | undefined;
  limit: number;
}

export class ContactRepository {
  constructor(private readonly db: PrismaClient) {}

  create(data: Prisma.ContactUncheckedCreateInput): Promise<Contact> {
    return this.db.contact.create({ data });
  }

  findById(id: string): Promise<ContactWithCompany | null> {
    return this.db.contact.findUnique({ where: { id }, include: { company: true } });
  }

  /** Returns only the contacts that exist; callers compare against the requested ids. */
  findByIds(ids: string[]): Promise<ContactWithCompany[]> {
    return this.db.contact.findMany({
      where: { id: { in: ids } },
      include: { company: true },
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
    });
  }

  search({ companyId, jobTitle, limit }: ContactSearchParams): Promise<Contact[]> {
    const where: Prisma.ContactWhereInput = {};
    if (companyId) where.companyId = companyId;
    if (jobTitle) where.jobTitle = { contains: jobTitle, mode: "insensitive" };
    return this.db.contact.findMany({ where, orderBy: [{ fullName: "asc" }, { id: "asc" }], take: limit });
  }

  /** Only fields that are provided are written; omitted fields keep their current value. */
  updateEnrichedFields(id: string, fields: { email?: string | null; linkedin?: string | null }): Promise<Contact> {
    const data: Prisma.ContactUpdateInput = {};
    if (fields.email !== undefined) data.email = fields.email;
    if (fields.linkedin !== undefined) data.linkedin = fields.linkedin;
    return this.db.contact.update({ where: { id }, data });
  }
}
