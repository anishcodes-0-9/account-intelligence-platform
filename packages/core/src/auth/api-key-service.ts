import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  CreateApiKeyInputSchema,
  SCOPES,
  type ApiKeyMetadata,
  type CreatedApiKey,
  type Scope,
} from "@aip/contracts";
import type { ApiKey } from "../db.js";
import { NotFoundError, UnauthenticatedError, ValidationError } from "../errors/app-error.js";
import { parseInput } from "../errors/parse-input.js";
import type { Logger } from "../logging/logger.js";
import type { ApiKeyRepository } from "../repositories/api-key-repository.js";
import type { AuthPrincipal } from "./principal.js";

/** Key format: `aip_<keyId>_<secret>`. keyId is the ApiKey row id (cuid: lowercase alphanumerics, no "_"). */
const KEY_PATTERN = /^aip_([a-z0-9]+)_([A-Za-z0-9_-]{43})$/;
const SECRET_BYTES = 32; // 256 bits -> 43 base64url chars
const INVALID_KEY_MESSAGE = "Invalid, expired or revoked API key";
const DEFAULT_LAST_USED_INTERVAL_MS = 60_000;

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const DUMMY_HASH = sha256Hex("aip-dummy-secret");

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

const isScope = (value: string): value is Scope => (SCOPES as readonly string[]).includes(value);

function toMetadata(record: ApiKey): ApiKeyMetadata {
  return {
    id: record.id,
    name: record.name,
    scopes: record.scopes.filter(isScope),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
  };
}

export interface ApiKeyServiceOptions {
  now?: () => Date;
  logger?: Logger;
  /** lastUsedAt is only rewritten when older than this, to avoid a write per request. */
  lastUsedIntervalMs?: number;
}

export class ApiKeyService {
  private readonly now: () => Date;
  private readonly logger: Logger | undefined;
  private readonly lastUsedIntervalMs: number;

  constructor(
    private readonly keys: ApiKeyRepository,
    options: ApiKeyServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
    this.lastUsedIntervalMs = options.lastUsedIntervalMs ?? DEFAULT_LAST_USED_INTERVAL_MS;
  }

  /** The raw key is in the return value only; just its SHA-256 is stored, so it cannot be shown again. */
  async create(input: unknown): Promise<CreatedApiKey> {
    const { name, scopes, expiresAt } = parseInput(CreateApiKeyInputSchema, input);
    const expires = expiresAt ? new Date(expiresAt) : undefined;
    if (expires && expires <= this.now()) throw new ValidationError("expiresAt: must be in the future");

    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const record = await this.keys.create({
      name,
      keyHash: sha256Hex(secret),
      scopes: [...new Set(scopes)],
      expiresAt: expires,
    });
    this.logger?.info({ keyId: record.id, scopes: record.scopes }, "api key created");
    return { key: `aip_${record.id}_${secret}`, metadata: toMetadata(record) };
  }

  /** Throws UnauthenticatedError with one generic message for every failure mode. */
  async verify(rawKey: string | null | undefined): Promise<AuthPrincipal> {
    const match = typeof rawKey === "string" ? KEY_PATTERN.exec(rawKey) : null;
    if (!match) throw new UnauthenticatedError(INVALID_KEY_MESSAGE);
    const [, keyId, secret] = match as unknown as [string, string, string];

    const record = await this.keys.findById(keyId);
    // Always hash and compare (against a dummy when the id is unknown) so timing does not reveal which ids exist.
    const hashMatches = safeEqualHex(sha256Hex(secret), record?.keyHash ?? DUMMY_HASH);
    const now = this.now();
    if (!record || !hashMatches || record.revokedAt || (record.expiresAt && record.expiresAt <= now)) {
      this.logger?.warn({ keyId }, "api key rejected");
      throw new UnauthenticatedError(INVALID_KEY_MESSAGE);
    }

    if (!record.lastUsedAt || now.getTime() - record.lastUsedAt.getTime() >= this.lastUsedIntervalMs) {
      try {
        await this.keys.markUsed(record.id, now);
      } catch (error) {
        // Bookkeeping must not turn a valid credential into a failed request.
        this.logger?.warn({ keyId, err: error }, "could not record api key last use");
      }
    }
    return { keyId: record.id, name: record.name, scopes: record.scopes.filter(isScope) };
  }

  async list(): Promise<ApiKeyMetadata[]> {
    return (await this.keys.list()).map(toMetadata);
  }

  /** Idempotent: revoking an already revoked key keeps the original revocation time. */
  async revoke(id: string): Promise<ApiKeyMetadata> {
    const record = await this.keys.findById(id);
    if (!record) throw new NotFoundError(`API key not found: ${id}`);
    if (record.revokedAt) return toMetadata(record);
    const revoked = await this.keys.revoke(id, this.now());
    this.logger?.info({ keyId: id }, "api key revoked");
    return toMetadata(revoked);
  }
}
