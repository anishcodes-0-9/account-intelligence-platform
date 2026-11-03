import { createHash, randomBytes } from "node:crypto";
import {
  EXPORT_MAX_CONTACTS,
  ExportContactsInputSchema,
  type ExportContactsOutput,
} from "@aip/contracts";
import { requireScope, type AuthPrincipal } from "../auth/principal.js";
import { ExportLimitError, NotFoundError } from "../errors/app-error.js";
import { parseInput } from "../errors/parse-input.js";
import type { Logger } from "../logging/logger.js";
import type { ContactRepository } from "../repositories/contact-repository.js";
import type { ExportRepository } from "../repositories/export-repository.js";
import { buildContactsCsv } from "./csv.js";

export const EXPORT_TTL_MS = 15 * 60_000;
const TOKEN_BYTES = 32; // 256 bits -> 43 base64url chars
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DOWNLOAD_NOT_FOUND = "Download not found or expired";

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface ExportServiceOptions {
  /** Origin the download URL is built on, e.g. "http://127.0.0.1:3001". The path is `/downloads/<token>`. */
  downloadBaseUrl: string;
  now?: () => Date;
  logger?: Logger;
}

export interface DownloadedExport {
  content: string;
  rowCount: number;
  expiresAt: Date;
}

export class ExportService {
  private readonly baseUrl: string;
  private readonly now: () => Date;
  private readonly logger: Logger | undefined;

  constructor(
    private readonly contacts: ContactRepository,
    private readonly exports: ExportRepository,
    options: ExportServiceOptions,
  ) {
    this.baseUrl = options.downloadBaseUrl.replace(/\/+$/, "");
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  /** The whole request fails if any id is unknown. Rows follow the request order, with duplicate ids collapsed. */
  async export(principal: AuthPrincipal, rawInput: unknown): Promise<ExportContactsOutput> {
    requireScope(principal, "contacts:export");
    const { contactIds } = parseInput(ExportContactsInputSchema, rawInput);
    if (contactIds.length > EXPORT_MAX_CONTACTS) {
      throw new ExportLimitError(`An export may include at most ${EXPORT_MAX_CONTACTS} contacts`);
    }
    const ids = [...new Set(contactIds)];
    const found = new Map((await this.contacts.findByIds(ids)).map((c) => [c.id, c]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) throw new NotFoundError(`Contacts not found: ${missing.join(", ")}`);

    const content = buildContactsCsv(
      ids.map((id) => {
        const c = found.get(id)!;
        return { id: c.id, name: c.fullName, title: c.jobTitle, email: c.email, linkedin: c.linkedin };
      }),
    );

    await this.purgeExpired();
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + EXPORT_TTL_MS);
    const job = await this.exports.create({
      apiKeyId: principal.keyId,
      contactIds: ids,
      rowCount: ids.length,
      content,
      tokenHash: sha256Hex(token),
      expiresAt,
    });
    // Only the id and counts are logged. The URL (and so the token) exists only in the returned value.
    this.logger?.info({ exportId: job.id, keyId: principal.keyId, rowCount: ids.length }, "export created");
    return { downloadUrl: `${this.baseUrl}/downloads/${token}`, exportId: job.id, expiresAt: expiresAt.toISOString(), rowCount: ids.length };
  }

  /**
   * The token is the credential. Unknown, malformed and expired tokens all give the same NOT_FOUND.
   * Lookup is by the token's SHA-256 (a unique index), so no comparison of secret bytes happens in application code.
   */
  async download(rawToken: string): Promise<DownloadedExport> {
    if (!TOKEN_PATTERN.test(rawToken)) throw new NotFoundError(DOWNLOAD_NOT_FOUND);
    const job = await this.exports.findByTokenHash(sha256Hex(rawToken));
    if (!job || job.expiresAt <= this.now()) throw new NotFoundError(DOWNLOAD_NOT_FOUND);
    this.logger?.info({ exportId: job.id }, "export downloaded");
    return { content: job.content, rowCount: job.rowCount, expiresAt: job.expiresAt };
  }

  /** Deletes expired exports and returns how many. Also runs before each new export. */
  async purgeExpired(): Promise<number> {
    const count = await this.exports.deleteExpired(this.now());
    if (count > 0) this.logger?.info({ count }, "expired exports purged");
    return count;
  }
}
