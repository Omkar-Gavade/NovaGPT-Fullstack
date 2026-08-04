import { Router } from "express";
import { validate } from "../middleware/validate.js";
import {
  serializeThread,
  serializeThreadSummary,
  serializeMessage,
} from "../serializers/threadSerializer.js";
import {
  listThreadsSchema,
  patchThreadSchema,
  settingsSchema,
  pinMessageSchema,
} from "../schemas/chatSchemas.js";

/**
 * Conversation lifecycle endpoints.
 *
 * `PUT` for settings and `PATCH` for the thread, deliberately: settings are a
 * complete object the client always holds in full, so replacement semantics are
 * honest and avoid the "is null a value or an omission?" ambiguity. Thread
 * metadata is edited one field at a time, where `PATCH` is the truthful verb
 * (docs/backend/09-api-design.md#conversations).
 */
export function threadController({ threadService, config }) {
  const router = Router();
  const owner = (req) => req.principal.ownerId;

  router.get("/threads", validate(listThreadsSchema, "query"), async (req, res) => {
    const { limit, cursor, archived, q } = req.validatedQuery;
    const page = await threadService.list({
      ownerId: owner(req),
      archived,
      limit,
      cursor,
      query: q,
    });

    res.json({
      data: page.items.map(serializeThreadSummary),
      // Cursor rather than offset: the sort key changes constantly as
      // conversations receive messages, and an offset would show one thread
      // twice while skipping another.
      meta: { cursor: page.nextCursor, hasMore: Boolean(page.nextCursor), limit },
    });
  });

  router.get("/threads/:threadId", async (req, res) => {
    const thread = await threadService.get(req.params.threadId, owner(req));
    res.json({ data: serializeThread(thread) });
  });

  router.patch("/threads/:threadId", validate(patchThreadSchema), async (req, res) => {
    const { threadId } = req.params;
    let thread;
    if (req.body.title !== undefined) thread = await threadService.rename(threadId, req.body.title, owner(req));
    if (req.body.pinned !== undefined) thread = await threadService.setPinned(threadId, req.body.pinned, owner(req));
    if (req.body.archived !== undefined) {
      thread = await threadService.setArchived(threadId, req.body.archived, owner(req));
    }
    if (!thread) thread = await threadService.get(threadId, owner(req));
    res.json({ data: serializeThread(thread, { includeMessages: false }) });
  });

  router.delete("/threads/:threadId", async (req, res) => {
    await threadService.delete(req.params.threadId, owner(req));
    // 30-day undo window, then a real purge. Communicated so a client can
    // offer the undo rather than treating deletion as final.
    res.json({ data: { deleted: true, recoverableForDays: 30 } });
  });

  router.post("/threads/:threadId/duplicate", async (req, res) => {
    const copy = await threadService.duplicate(req.params.threadId, owner(req));
    res.status(201).json({ data: serializeThread(copy) });
  });

  /* -------------------------------- settings --------------------------- */

  router.get("/threads/:threadId/settings", async (req, res) => {
    const thread = await threadService.get(req.params.threadId, owner(req));
    res.json({ data: thread.settings.toJSON() });
  });

  router.put("/threads/:threadId/settings", validate(settingsSchema), async (req, res) => {
    const settings = await threadService.updateSettings(req.params.threadId, req.body, owner(req));
    res.json({ data: settings.toJSON() });
  });

  /* --------------------------------- pinning --------------------------- */

  router.patch(
    "/threads/:threadId/messages/:messageId/pin",
    validate(pinMessageSchema),
    async (req, res) => {
      const thread = await threadService.pinMessage(
        req.params.threadId,
        req.params.messageId,
        req.body.pinned,
        owner(req)
      );
      res.json({ data: serializeMessage(thread.findMessage(req.params.messageId)) });
    }
  );

  /* --------------------------------- sharing --------------------------- */

  router.post("/threads/:threadId/share", async (req, res) => {
    // Idempotent: a double-click must not mint a second link the user cannot
    // see and therefore cannot revoke.
    const share = await threadService.share(
      req.params.threadId,
      owner(req),
      config.http.publicUrl
    );
    res.json({ data: share });
  });

  router.delete("/threads/:threadId/share", async (req, res) => {
    await threadService.unshare(req.params.threadId, owner(req));
    res.json({ data: { shared: false } });
  });

  return router;
}

/** Public share view. Mounted unauthenticated, so it is kept separate. */
export function shareController({ threadService }) {
  const router = Router();

  router.get("/share/:shareId", async (req, res) => {
    const shared = await threadService.getShared(req.params.shareId);
    res.json({
      data: {
        title: shared.title,
        messages: shared.messages.map(serializeMessage),
        createdAt: shared.createdAt.toISOString(),
      },
    });
  });

  return router;
}
