import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Logger } from "../../src/infrastructure/telemetry/Logger.js";
import { runWithContext } from "../../src/infrastructure/telemetry/traceContext.js";
import { Secret } from "../../src/infrastructure/telemetry/Secret.js";
import { recordingLogger } from "../helpers/testDoubles.js";

describe("Logger", () => {
  test("emits one JSON object per line", () => {
    const logger = recordingLogger();
    logger.info("thing.happened", { count: 3 });
    assert.equal(logger.lines.length, 1);
    assert.equal(logger.lines[0].event, "thing.happened");
    assert.equal(logger.lines[0].level, "info");
    assert.equal(logger.lines[0].count, 3);
    assert.ok(Date.parse(logger.lines[0].time));
  });

  test("filters below the configured level", () => {
    const logger = recordingLogger("warn");
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    assert.deepEqual(logger.lines.map((l) => l.event), ["c", "d"]);
  });

  test("silent emits nothing at all", () => {
    const logger = recordingLogger("silent");
    logger.error("critical");
    assert.equal(logger.lines.length, 0);
  });

  test("child loggers inherit and extend bound fields", () => {
    const logger = recordingLogger();
    logger.child({ component: "mongo" }).child({ pool: 1 }).info("connected");
    assert.equal(logger.lines[0].component, "mongo");
    assert.equal(logger.lines[0].pool, 1);
  });

  test("attaches the ambient trace context without being passed it", () => {
    const logger = recordingLogger();
    runWithContext({ traceId: "T1", requestId: "R1", correlationId: "T1" }, () => {
      logger.info("in.request");
    });
    assert.equal(logger.lines[0].traceId, "T1");
    assert.equal(logger.lines[0].requestId, "R1");
    // Omitted when identical to traceId, to keep the common line uncluttered.
    assert.equal(logger.lines[0].correlationId, undefined);
  });

  test("emits correlationId when it differs from traceId", () => {
    const logger = recordingLogger();
    runWithContext({ traceId: "T1", requestId: "R1", correlationId: "C9" }, () => {
      logger.info("in.request");
    });
    assert.equal(logger.lines[0].correlationId, "C9");
  });

  test("works outside a request context", () => {
    const logger = recordingLogger();
    assert.doesNotThrow(() => logger.info("boot.starting"));
    assert.equal(logger.lines[0].traceId, undefined);
  });

  test("redacts secrets passed as fields", () => {
    const logger = recordingLogger();
    logger.info("boot", { uri: new Secret("mongodb://u:p@h/db", "MONGODB_URI"), apiKey: "x" });
    const line = JSON.stringify(logger.lines[0]);
    assert.ok(!line.includes("u:p@h"));
    assert.ok(line.includes("[REDACTED:MONGODB_URI]"));
    assert.ok(!line.includes('"apiKey":"x"'));
  });

  test("never throws, even when the stream fails", () => {
    // A logger that throws takes down the request it was describing.
    const logger = new Logger({
      level: "info",
      stream: {
        write() {
          throw new Error("EPIPE");
        },
      },
    });
    assert.doesNotThrow(() => logger.info("event"));
  });

  test("never throws on an unserialisable payload", () => {
    const logger = recordingLogger();
    const circular = {};
    circular.self = circular;
    assert.doesNotThrow(() => logger.info("event", { circular, big: 1n }));
  });

  test("pretty output is human-readable and carries no JSON braces", () => {
    const written = [];
    const logger = new Logger({
      level: "info",
      pretty: true,
      stream: { write: (t) => written.push(t) },
    });
    logger.info("request.completed", { status: 200 });
    assert.ok(written[0].includes("request.completed"));
    assert.ok(written[0].includes("status=200"));
  });
});
