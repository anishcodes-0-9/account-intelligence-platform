// Builds the real service instances the MCP tools call. Shared by both transports so stdio and HTTP
// run the exact same business logic, not separate copies.
import {
  ApiKeyRepository,
  ApiKeyService,
  CompanyRepository,
  CompanyService,
  ContactRepository,
  ContactService,
  createPrismaClient,
  EnrichmentService,
  ExportRepository,
  ExportService,
  MockEnrichmentProvider,
  type Logger,
  type PrismaClient,
} from "@aip/core";

export interface McpServices {
  companies: CompanyService;
  contacts: ContactService;
  enrichment: EnrichmentService;
  exports: ExportService;
  apiKeys: ApiKeyService;
}

export interface BuildServicesOptions {
  databaseUrl: string;
  downloadBaseUrl: string;
  logger: Logger;
}

export interface BuiltServices {
  db: PrismaClient;
  services: McpServices;
}

export function buildServices(options: BuildServicesOptions): BuiltServices {
  const db = createPrismaClient(options.databaseUrl);
  const companyRepo = new CompanyRepository(db);
  const contactRepo = new ContactRepository(db);
  const exportRepo = new ExportRepository(db);
  const apiKeyRepo = new ApiKeyRepository(db);

  const services: McpServices = {
    companies: new CompanyService(companyRepo),
    contacts: new ContactService(contactRepo, companyRepo),
    enrichment: new EnrichmentService(db, new MockEnrichmentProvider(), { logger: options.logger }),
    exports: new ExportService(contactRepo, exportRepo, { downloadBaseUrl: options.downloadBaseUrl, logger: options.logger }),
    apiKeys: new ApiKeyService(apiKeyRepo, { logger: options.logger }),
  };
  return { db, services };
}
