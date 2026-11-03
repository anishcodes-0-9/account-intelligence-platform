import type { Scope } from "@aip/contracts";
import { ForbiddenError } from "../errors/app-error.js";

/** The verified caller. Built only by ApiKeyService.verify; services take it as their first argument. */
export interface AuthPrincipal {
  keyId: string;
  name: string;
  scopes: readonly Scope[];
}

export function requireScope(principal: AuthPrincipal, scope: Scope): void {
  if (!principal.scopes.includes(scope)) throw new ForbiddenError(`Missing required scope: ${scope}`);
}
