// GET /downloads/:token -- serves ExportService.download, the same export storage export_contacts
// (MCP) and POST /api/contacts/export (REST) both write to. The token itself is the credential (its
// SHA-256 is the lookup key), so this route takes no Authorization header; unknown, malformed and
// expired tokens all fall through ExportService.download's single NotFoundError, so they are
// indistinguishable here too.
import type { FastifyInstance } from "fastify";
import { mapError, type ExportService, type Logger } from "@aip/core";

export function registerDownloadRoute(app: FastifyInstance, exports: ExportService, logger: Logger): void {
  app.get("/downloads/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    try {
      const { content } = await exports.download(token);
      return reply
        .code(200)
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="contacts.csv"')
        .send(content);
    } catch (error) {
      const { httpStatus, body } = mapError(error, logger, { route: "GET /downloads/:token" });
      return reply.code(httpStatus).send(body);
    }
  });
}
