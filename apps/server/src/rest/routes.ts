// REST endpoints for the same five core capabilities the MCP tools expose. Route handlers are thin:
// parse -> call the existing service with the existing @aip/contracts input shape -> map result/error.
// No business rule is duplicated here; CompanyService/ContactService/EnrichmentService/ExportService and
// their requireScope checks are exactly what MCP calls (apps/server/src/mcp/register-tools.ts).
import type { FastifyInstance } from "fastify";
import { mapError, type Logger } from "@aip/core";
import type { McpServices } from "../mcp/services.js";
import { requireApiKey, type AuthedRequest } from "./auth.js";

function companiesQueryInput(query: unknown): Record<string, unknown> {
  const q = (query ?? {}) as Record<string, unknown>;
  const input: Record<string, unknown> = {};
  if (typeof q.query === "string") input.query = q.query;
  if (typeof q.country === "string") input.country = q.country;
  if (typeof q.limit === "string") input.limit = Number(q.limit);
  return input;
}

function contactsQueryInput(query: unknown): Record<string, unknown> {
  const q = (query ?? {}) as Record<string, unknown>;
  const input: Record<string, unknown> = {};
  if (typeof q.companyId === "string") input.companyId = q.companyId;
  if (typeof q.jobTitle === "string") input.jobTitle = q.jobTitle;
  return input;
}

export function registerRestRoutes(app: FastifyInstance, services: McpServices, logger: Logger): void {
  const auth = requireApiKey(services.apiKeys, logger);

  app.get("/api/companies", { preHandler: auth }, async (request, reply) => {
    try {
      const result = await services.companies.search((request as AuthedRequest).principal, companiesQueryInput(request.query));
      return reply.code(200).send(result);
    } catch (error) {
      const { httpStatus, body } = mapError(error, logger, { route: "GET /api/companies" });
      return reply.code(httpStatus).send(body);
    }
  });

  app.get("/api/companies/:companyId", { preHandler: auth }, async (request, reply) => {
    const { companyId } = request.params as { companyId: string };
    try {
      const result = await services.companies.getById((request as AuthedRequest).principal, { companyId });
      return reply.code(200).send(result);
    } catch (error) {
      const { httpStatus, body } = mapError(error, logger, { route: "GET /api/companies/:companyId" });
      return reply.code(httpStatus).send(body);
    }
  });

  app.get("/api/contacts", { preHandler: auth }, async (request, reply) => {
    try {
      const result = await services.contacts.search((request as AuthedRequest).principal, contactsQueryInput(request.query));
      return reply.code(200).send(result);
    } catch (error) {
      const { httpStatus, body } = mapError(error, logger, { route: "GET /api/contacts" });
      return reply.code(httpStatus).send(body);
    }
  });

  app.post("/api/contacts/:contactId/enrich", { preHandler: auth }, async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    try {
      const result = await services.enrichment.enrich((request as AuthedRequest).principal, { contactId });
      return reply.code(200).send(result);
    } catch (error) {
      const { httpStatus, body } = mapError(error, logger, { route: "POST /api/contacts/:contactId/enrich" });
      return reply.code(httpStatus).send(body);
    }
  });

  app.post("/api/contacts/export", { preHandler: auth }, async (request, reply) => {
    try {
      const result = await services.exports.export((request as AuthedRequest).principal, request.body);
      return reply.code(200).send(result);
    } catch (error) {
      const { httpStatus, body } = mapError(error, logger, { route: "POST /api/contacts/export" });
      return reply.code(httpStatus).send(body);
    }
  });
}
