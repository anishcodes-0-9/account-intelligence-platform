// REST Bearer-key authentication, reusing the exact ApiKeyService the MCP HTTP route already verifies
// against (packages/core/src/auth/api-key-service.ts) -- same scopes, same failure mode, same codes.
import type { FastifyReply, FastifyRequest } from "fastify";
import { mapError, type ApiKeyService, type AuthPrincipal, type Logger } from "@aip/core";

export interface AuthedRequest extends FastifyRequest {
  principal: AuthPrincipal;
}

/** Scope enforcement happens inside each service (requireScope), identically to MCP; this only authenticates. */
export function requireApiKey(apiKeys: ApiKeyService, logger: Logger) {
  return async function auth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    try {
      (request as AuthedRequest).principal = await apiKeys.verify(token);
    } catch (error) {
      const { httpStatus, body } = mapError(error, logger, { route: request.url });
      await reply.code(httpStatus).header("WWW-Authenticate", 'Bearer realm="aip", error="invalid_token"').send(body);
    }
  };
}
