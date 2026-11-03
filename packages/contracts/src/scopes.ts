import * as z from "zod/v4";

export const SCOPES = ["companies:read", "contacts:read", "contacts:enrich", "contacts:export"] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;
