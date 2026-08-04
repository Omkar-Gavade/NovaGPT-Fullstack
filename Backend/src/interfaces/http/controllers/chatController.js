import { Router } from "express";
import { SseWriter } from "../SseWriter.js";
import { serializeMessage, serializeThread } from "../serializers/threadSerializer.js";
import { errorEnvelope } from "../serializers/errorEnvelope.js";
import { validate } from "../middleware/validate.js";
import { AppError, ErrorKind, CancelledError } from "../../../domain/errors/index.js";
import {
  sendMessageSchema,
  regenerateSchema,
  continueSchema,
  stopSchema,
} from "../schemas/chatSchemas.js";

/**
 * An AbortController that fires when the **client** goes away.
 *
 * Listening on `req` is the obvious-looking mistake and it is wrong: `req`
 * emits `close` when the request *body* has finished being read, which for any
 * POST happens long before the response is written — so every request would
 * cancel itself immediately.
 *
 * `res` emits `close` when the response completes *or* the connection drops;
 * `writableEnded` distinguishes the two. Only the second is a cancellation.
 */
function clientAbort(req, res) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort(new CancelledError());
  });
  return controller;
}

/**
 * Chat endpoints.
 *
 * Thin: parse, delegate to the orchestrator, serialise. Any `if` here that
 * decides *what the system does* rather than *how to say it over HTTP* belongs
 * in a use case (docs/backend/02-architecture.md#interface-layer-srcinterfaces).
 *
 * The one genuinely interesting thing in this file is error handling on the
 * streaming route, because the status code is committed the moment headers are
 * flushed.
 */
export function chatController({ orchestrator, logger, limit = [] }) {
  const router = Router();

  // Attached per route, not with `router.use`: a router-level middleware also
  // runs for requests that fall through to a later controller, so mounting it
  // that way would charge every thread listing against the chat budget.
  //
  // `/chat/stop` is deliberately not limited. Stopping a stream *reduces* load,
  // and a user who has hit the limit is exactly the user most likely to want to
  // cancel something.
  const guards = Array.isArray(limit) ? limit : [limit];

  /* ------------------------------- non-streaming ----------------------- */

  router.post("/chat", ...guards, validate(sendMessageSchema), async (req, res) => {
    // A disconnected client's request must stop consuming provider quota now.
    const controller = clientAbort(req, res);

    const result = await orchestrator.send({
      threadId: req.body.threadId,
      ownerId: req.principal.ownerId,
      message: req.body.message,
      attachments: req.body.attachments,
      settings: req.body.settings,
      tools: req.body.tools,
      responseFormat: req.body.responseFormat,
      signal: controller.signal,
    });

    res.json({
      data: {
        threadId: result.thread.id,
        message: serializeMessage(result.assistantMessage),
        switched: result.switched
          ? {
              from: result.switched.from.id,
              to: result.switched.to.id,
              reason: result.switched.reason,
              message: result.switched.message,
            }
          : null,
      },
      meta: {
        model: result.assistantMessage.model,
        provider: result.assistantMessage.provider,
        usage: result.assistantMessage.usage,
      },
    });
  });

  /* --------------------------------- streaming ------------------------- */

  router.post("/chat/stream", ...guards, validate(sendMessageSchema), async (req, res) => {
    const controller = clientAbort(req, res);

    let writer;
    try {
      const { streamId, thread, events } = await orchestrator.beginStream({
        threadId: req.body.threadId,
        ownerId: req.principal.ownerId,
        message: req.body.message,
        attachments: req.body.attachments,
        settings: req.body.settings,
        streaming: true,
        signal: controller.signal,
      });

      // Everything above can still fail as a normal HTTP error — routing may
      // find no candidate, the context may not fit. Headers go out only once
      // the stream is genuinely starting.
      writer = new SseWriter(res, { logger }).start();

      // The client needs the id and the thread id before any token: without
      // them it cannot stop the stream, and on a new conversation it does not
      // know what it is talking to.
      await writer.write({ type: "stream", streamId, threadId: thread.id });

      const { sawTerminal } = await writer.pipe(events);
      if (!sawTerminal) {
        await writer.writeTerminalIfMissing(
          ErrorKind.INTERNAL,
          "The stream ended unexpectedly."
        );
      }
      writer.end();
    } catch (error) {
      const normalised = AppError.from(error);

      // Headers already sent means the status is committed at 200 and cannot
      // be revised. A client expecting errors as status codes would hang
      // forever on a stream that failed at token 300, so the error must arrive
      // as an event (docs/backend/07-streaming-engine.md#error-propagation).
      if (writer?.open) {
        await writer.write({
          type: "error",
          kind: normalised.kind,
          message: normalised.message,
          traceId: req.context?.traceId ?? null,
        });
        writer.end();
        return;
      }

      // Nothing committed yet, so a normal HTTP error is still possible and is
      // strictly more useful to the client.
      res.status(normalised.status).json(errorEnvelope(normalised, req.context?.traceId));
    }
  });

  /* ------------------------------ regenerate --------------------------- */

  router.post("/chat/regenerate", ...guards, validate(regenerateSchema), async (req, res) => {
    const controller = clientAbort(req, res);

    const result = await orchestrator.regenerate({
      threadId: req.body.threadId,
      messageId: req.body.messageId,
      ownerId: req.principal.ownerId,
      settings: req.body.settings,
      signal: controller.signal,
      streaming: false,
    });

    res.json({
      data: {
        threadId: result.thread.id,
        message: serializeMessage(result.assistantMessage),
      },
    });
  });

  /* -------------------------------- continue --------------------------- */

  router.post("/chat/continue", ...guards, validate(continueSchema), async (req, res) => {
    const controller = clientAbort(req, res);

    const result = await orchestrator.continue_({
      threadId: req.body.threadId,
      messageId: req.body.messageId,
      ownerId: req.principal.ownerId,
      settings: req.body.settings,
      signal: controller.signal,
    });

    res.json({
      data: {
        threadId: result.thread.id,
        message: serializeMessage(result.assistantMessage),
      },
    });
  });

  /* ---------------------------------- stop ----------------------------- */

  /**
   * Stop arrives on a different connection from the stream it cancels, which is
   * why the registry exists at all. Returns 200 with `stopped: false` rather
   * than 404 for an unknown id: the stream having already finished is a race,
   * not a client error, and a 404 invites a pointless retry.
   */
  router.post("/chat/stop", validate(stopSchema), (req, res) => {
    const stopped = orchestrator.stop(req.body.streamId, req.principal.ownerId);
    res.json({ data: { streamId: req.body.streamId, stopped } });
  });

  return router;
}
