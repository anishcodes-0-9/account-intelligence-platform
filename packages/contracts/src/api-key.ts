import * as z from "zod/v4";
import { ScopeSchema } from "./scopes.js";

export const CreateApiKeyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ScopeSchema).min(1),
  expiresAt: z.iso.datetime().optional(),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInputSchema>;

/** Safe to display or log: never contains the key or its hash. */
export const ApiKeyMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(ScopeSchema),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type ApiKeyMetadata = z.infer<typeof ApiKeyMetadataSchema>;

/** `key` is the raw credential, returned exactly once at creation. */
export const CreatedApiKeySchema = z.object({ key: z.string(), metadata: ApiKeyMetadataSchema });
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;
