// The one place the five MCP tools are defined. `createAipMcpServer` (create-server.ts) calls this for
// both the stdio and Streamable HTTP entry points, so the tool definitions, input/output schemas and
// business logic are never duplicated between transports -- only how a principal is resolved differs.
import type { AuthInfo, McpServer } from "@modelcontextprotocol/server";
import {
  CompanyDetailSchema,
  EnrichContactInputSchema,
  EnrichContactOutputSchema,
  ExportContactsInputSchema,
  ExportContactsOutputSchema,
  GetCompanyInputSchema,
  SearchCompaniesInputSchema,
  SearchCompaniesOutputSchema,
  SearchContactsInputSchema,
  SearchContactsOutputSchema,
} from "@aip/contracts";
import { mapError, UnauthenticatedError, type AuthPrincipal, type Logger } from "@aip/core";
import type { McpServices } from "./services.js";

/** What this module stores in `AuthInfo.extra` -- never anything the client supplied. */
interface PrincipalExtra {
  keyId: string;
  name: string;
  scopes: AuthPrincipal["scopes"];
}

/**
 * Builds the `AuthInfo` the Fastify auth hook stashes on `request.raw.auth` for the HTTP transport.
 * `principal` must already be the result of a real `ApiKeyService.verify` call -- this function only
 * carries it through the SDK's auth-info channel, it never re-derives or trusts anything from the client.
 */
export function authInfoFor(principal: AuthPrincipal): AuthInfo {
  return {
    token: "[redacted]",
    clientId: principal.keyId,
    scopes: [...principal.scopes],
    extra: { keyId: principal.keyId, name: principal.name, scopes: principal.scopes } satisfies PrincipalExtra,
  };
}

/** The inverse of {@link authInfoFor}. Throws if no server-verified principal was attached. */
export function principalFromAuthInfo(authInfo: AuthInfo | undefined): AuthPrincipal {
  const extra = authInfo?.extra as PrincipalExtra | undefined;
  if (!extra) throw new UnauthenticatedError("Authentication required");
  return { keyId: extra.keyId, name: extra.name, scopes: extra.scopes };
}

/**
 * Resolves the authenticated caller for one tool invocation. For stdio this ignores `ctx` and always
 * returns the principal verified once at process startup; for HTTP it reads the `AuthInfo` the Fastify
 * auth hook attached to this request (via {@link principalFromAuthInfo}) -- never arguments supplied by
 * the MCP client itself.
 */
export type PrincipalResolver = (ctx: { http?: { authInfo?: AuthInfo } }) => AuthPrincipal;

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
}

/** Tool handlers must never throw raw errors to the SDK (it echoes a thrown message verbatim to the client). */
function fail(error: unknown, logger: Logger, context: Record<string, unknown>) {
  const { body } = mapError(error, logger, context);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: body.error.message }],
    structuredContent: { error: body.error },
  };
}

export function registerTools(server: McpServer, services: McpServices, resolvePrincipal: PrincipalResolver, logger: Logger): void {
  server.registerTool(
    "search_companies",
    {
      title: "Search companies",
      description: "Search companies by free-text query and/or country. Requires the companies:read scope.",
      inputSchema: SearchCompaniesInputSchema,
      outputSchema: SearchCompaniesOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input, ctx) => {
      try {
        return ok(await services.companies.search(resolvePrincipal(ctx), input));
      } catch (error) {
        return fail(error, logger, { tool: "search_companies" });
      }
    },
  );

  server.registerTool(
    "get_company",
    {
      title: "Get company",
      description: "Fetch one company by id. Requires the companies:read scope.",
      inputSchema: GetCompanyInputSchema,
      outputSchema: CompanyDetailSchema,
      annotations: { readOnlyHint: true },
    },
    async (input, ctx) => {
      try {
        return ok(await services.companies.getById(resolvePrincipal(ctx), input));
      } catch (error) {
        return fail(error, logger, { tool: "get_company" });
      }
    },
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description: "Search contacts by companyId and/or jobTitle. Requires the contacts:read scope.",
      inputSchema: SearchContactsInputSchema,
      outputSchema: SearchContactsOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input, ctx) => {
      try {
        return ok(await services.contacts.search(resolvePrincipal(ctx), input));
      } catch (error) {
        return fail(error, logger, { tool: "search_contacts" });
      }
    },
  );

  server.registerTool(
    "enrich_contact",
    {
      title: "Enrich contact",
      description:
        "Enrich one contact's email and LinkedIn via the synthetic mock provider. Requires the contacts:enrich scope. " +
        "Results are synthetic fixtures, never verified real-world data.",
      inputSchema: EnrichContactInputSchema,
      outputSchema: EnrichContactOutputSchema,
    },
    async (input, ctx) => {
      try {
        return ok(await services.enrichment.enrich(resolvePrincipal(ctx), input));
      } catch (error) {
        return fail(error, logger, { tool: "enrich_contact" });
      }
    },
  );

  server.registerTool(
    "export_contacts",
    {
      title: "Export contacts",
      description:
        "Export up to 200 contacts as a CSV download link, valid for 15 minutes. Requires the contacts:export scope.",
      inputSchema: ExportContactsInputSchema,
      outputSchema: ExportContactsOutputSchema,
    },
    async (input, ctx) => {
      try {
        return ok(await services.exports.export(resolvePrincipal(ctx), input));
      } catch (error) {
        return fail(error, logger, { tool: "export_contacts" });
      }
    },
  );
}
