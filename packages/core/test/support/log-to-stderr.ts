// Fixture: logs once through the stderr destination so a test can prove stdout stays empty.
import { createLogger, stderrDestination } from "../../src/logging/logger.js";

const logger = createLogger({ destination: stderrDestination(), name: "stderr-fixture" });
logger.info({ contactId: "cnt_1", apiKey: "aip_abc_SHOULD_NOT_APPEAR" }, "hello from stderr");
