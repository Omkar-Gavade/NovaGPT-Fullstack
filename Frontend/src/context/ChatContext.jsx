import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, StreamEvent } from "../services/api";
import { msgId } from "../utils/format";

const ChatContext = createContext(null);

/**
 * `model: null` means "let the router choose".
 *
 * The old default pinned `gemini-2.5-flash` on every new conversation, which
 * silently disabled the routing engine: a pinned model wins over ranking while
 * it is usable, so the fleet's health, latency and cost ordering never applied.
 * Null lets the router pick, and the user can still pin from the dropdown.
 */
const DEFAULT_SETTINGS = {
  model: null,
  temperature: 0.7,
  maxTokens: 2048,
  topP: 1,
  systemPrompt: "",
  switchPolicy: "auto", // auto | ask | never
};

/**
 * Owns the multi-model workspace: threads, the active conversation, the live
 * model catalog + provider status, per-conversation generation settings, and
 * streaming with router failover notices.
 *
 * Talks to API v1 exclusively. Two consequences worth knowing:
 *
 *   - Thread list rows are **summaries** with no message bodies; the backend
 *     projects them out so the sidebar does not load every message of every
 *     conversation. Cross-conversation message search therefore falls back to
 *     title matching until semantic search lands.
 *   - Streaming is a **typed event protocol**, not a string of deltas, which is
 *     what makes `switched`, `usage` and `reasoning` expressible at all.
 */
export function ChatProvider({ children }) {
  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [currentThreadId, setCurrentThreadId] = useState(() => crypto.randomUUID());
  const [searchQuery, setSearchQuery] = useState("");

  const [catalog, setCatalog] = useState([]);
  const [providers, setProviders] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [isStreaming, setIsStreaming] = useState(false);
  const [notice, setNotice] = useState(null); // failover / error banner
  const abortRef = useRef(null);
  // The server-side stream id, so stopping halts generation rather than only
  // our reading of it.
  const streamIdRef = useRef(null);

  /* ------------------------------ catalog ------------------------------ */

  const refreshCatalog = useCallback(async () => {
    try {
      const [models, snapshot] = await Promise.all([api.listModels(), api.listProviders()]);
      setCatalog(models.data ?? []);
      // The snapshot separates configured providers from those skipped for a
      // fixable reason; the UI only renders the registered ones.
      setProviders(snapshot?.registered ?? []);
    } catch (err) {
      console.error("Failed to load model catalog:", err.message);
    }
  }, []);

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  const activeModel = useMemo(
    () => catalog.find((m) => m.id === settings.model) ?? null,
    [catalog, settings.model]
  );

  /* ------------------------------ threads ------------------------------ */

  const refreshThreads = useCallback(async () => {
    try {
      const page = await api.listThreads({ limit: 50 });
      const mapped = (page.data ?? []).map((t) => ({
        // The API calls it `id`; the components have always called it
        // `threadId`, and renaming it across every component would be churn
        // with no benefit.
        threadId: t.id,
        title: t.title || "New chat",
        messageCount: t.messageCount ?? 0,
        pinned: Boolean(t.pinned),
        archived: Boolean(t.archived),
        shareId: t.shareId ?? null,
        timestamp: t.lastMessageAt || t.updatedAt || new Date(),
        // Empty by design: list rows carry no message bodies. Hover previews
        // and message search degrade to titles until the thread is opened.
        messages: [],
        lastMessage: `${t.messageCount ?? 0} message${t.messageCount === 1 ? "" : "s"}`,
      }));

      mapped.sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.timestamp) - new Date(a.timestamp)
      );
      setThreads(mapped);
    } catch (err) {
      console.error("Failed to load threads:", err.message);
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshThreads();
  }, [refreshThreads]);

  const startNewChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setSearchQuery("");
    setNotice(null);
    setCurrentThreadId(crypto.randomUUID());
    setSettings((s) => ({ ...DEFAULT_SETTINGS, model: s.model })); // keep chosen model
  }, []);

  const selectThread = useCallback(async (threadId) => {
    abortRef.current?.abort();
    setCurrentThreadId(threadId);
    setSearchQuery("");
    setNotice(null);
    try {
      // One request: the thread carries its messages *and* its settings, so
      // the previous two round trips were one more than necessary.
      const thread = await api.getThread(threadId);
      setMessages((thread?.messages ?? []).map(toUiMessage));
      setSettings({ ...DEFAULT_SETTINGS, ...(thread?.settings ?? {}) });
    } catch (err) {
      console.error("Failed to open thread:", err.message);
      setMessages([]);
    }
  }, []);

  const deleteThread = useCallback(
    async (threadId) => {
      try {
        await api.deleteThread(threadId);
        setThreads((prev) => prev.filter((t) => t.threadId !== threadId));
        if (threadId === currentThreadId) startNewChat();
      } catch (err) {
        console.error("Failed to delete thread:", err.message);
      }
    },
    [currentThreadId, startNewChat]
  );

  /** Optimistic patch (rename / pin / archive) with revert on failure. */
  const patchThread = useCallback(async (threadId, patch) => {
    let prevSnapshot;
    setThreads((prev) => {
      prevSnapshot = prev;
      const next = prev.map((t) => (t.threadId === threadId ? { ...t, ...patch } : t));
      next.sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.timestamp) - new Date(a.timestamp)
      );
      return next;
    });
    try {
      await api.patchThread(threadId, patch);
    } catch (err) {
      console.error("Failed to update thread:", err.message);
      setThreads(prevSnapshot);
    }
  }, []);

  const renameThread = useCallback((threadId, title) => patchThread(threadId, { title }), [patchThread]);
  const pinThread = useCallback((threadId, pinned) => patchThread(threadId, { pinned }), [patchThread]);
  const archiveThread = useCallback(
    (threadId, archived) => patchThread(threadId, { archived }),
    [patchThread]
  );

  const duplicateThread = useCallback(
    async (threadId) => {
      try {
        const copy = await api.duplicateThread(threadId);
        await refreshThreads();
        return copy?.id;
      } catch (err) {
        console.error("Failed to duplicate thread:", err.message);
      }
    },
    [refreshThreads]
  );

  const shareThread = useCallback(async (threadId) => {
    try {
      const share = await api.shareThread(threadId);
      if (share?.url && navigator.clipboard) await navigator.clipboard.writeText(share.url);
      return share?.url;
    } catch (err) {
      console.error("Failed to share thread:", err.message);
    }
  }, []);

  /* ------------------------------ settings ----------------------------- */

  const updateSettings = useCallback(
    (patch) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        // Only persists for threads that exist server-side. A thread is created
        // by its first message, so this is a no-op before then.
        api.saveSettings(currentThreadId, next).catch(() => {});
        return next;
      });
    },
    [currentThreadId]
  );

  const selectModel = useCallback((modelId) => updateSettings({ model: modelId }), [updateSettings]);

  /* ------------------------------ sending ------------------------------ */

  const patchMessage = useCallback((id, patch) => {
    setMessages((prev) => prev.map((m) => (msgId(m) === id ? { ...m, ...patch } : m)));
  }, []);

  const sendMessage = useCallback(
    async (text) => {
      const content = text.trim();
      if (!content || isStreaming) return;

      const userId = crypto.randomUUID();
      const aiId = crypto.randomUUID();
      const now = new Date();

      setNotice(null);
      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", content, timestamp: now },
        {
          id: aiId,
          role: "assistant",
          content: "",
          reasoning: "",
          timestamp: now,
          isStreaming: true,
          model: settings.model,
        },
      ]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      streamIdRef.current = null;

      try {
        await api.streamMessage(
          { threadId: currentThreadId, message: content, settings },
          (evt) => {
            switch (evt.type) {
              case StreamEvent.STREAM:
                // Arrives before any token. The stream id is what makes an
                // explicit stop possible; the thread id matters because the
                // server creates the thread on the first message.
                streamIdRef.current = evt.streamId;
                if (evt.threadId) setCurrentThreadId(evt.threadId);
                break;

              case StreamEvent.START:
                patchMessage(aiId, { model: evt.model, provider: evt.provider });
                break;

              case StreamEvent.DELTA:
                setMessages((prev) =>
                  prev.map((m) => (msgId(m) === aiId ? { ...m, content: m.content + evt.text } : m))
                );
                break;

              case StreamEvent.REASONING:
                // Kept separate from the answer so it can be collapsed, and so
                // it is never mistaken for the reply itself.
                setMessages((prev) =>
                  prev.map((m) =>
                    msgId(m) === aiId ? { ...m, reasoning: (m.reasoning ?? "") + evt.text } : m
                  )
                );
                break;

              case StreamEvent.SWITCHED:
                // Failover is never silent. `discardPartial` means the previous
                // attempt's tokens must go: two models do not continue each
                // other's sentences.
                setNotice({
                  type: "switch",
                  message: evt.message,
                  from: { id: evt.from?.model, provider: evt.from?.provider },
                  to: { id: evt.to?.model, provider: evt.to?.provider },
                  reason: evt.reason,
                });
                patchMessage(aiId, {
                  model: evt.to?.model,
                  provider: evt.to?.provider,
                  ...(evt.discardPartial ? { content: "", reasoning: "" } : {}),
                });
                break;

              case StreamEvent.USAGE:
                patchMessage(aiId, {
                  usage: {
                    promptTokens: evt.promptTokens,
                    completionTokens: evt.completionTokens,
                  },
                });
                break;

              case StreamEvent.DONE:
                patchMessage(aiId, {
                  isStreaming: false,
                  model: evt.model,
                  provider: evt.provider,
                  finishReason: evt.finishReason,
                });
                break;

              case StreamEvent.ERROR:
                patchMessage(aiId, { isStreaming: false, error: true });
                setNotice({
                  type: "error",
                  message: evt.message,
                  kind: evt.kind,
                  traceId: evt.traceId,
                });
                break;

              default:
                // Unknown event types are ignored, which is what keeps a new
                // backend event from breaking an older client.
                break;
            }
          },
          controller.signal
        );
      } catch (err) {
        if (err.name !== "AbortError") {
          patchMessage(aiId, { content: `Error: ${err.message}`, isStreaming: false, error: true });
          setNotice({ type: "error", message: err.message, kind: err.kind, traceId: err.traceId });
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        streamIdRef.current = null;
        patchMessage(aiId, { isStreaming: false });
        refreshThreads();
        refreshCatalog();
      }
    },
    [currentThreadId, settings, isStreaming, patchMessage, refreshThreads, refreshCatalog]
  );

  /**
   * Stop generating.
   *
   * Tells the server first, then aborts locally. Aborting alone only stops
   * *us reading*; the provider would keep generating and keep charging for
   * output nobody will see.
   */
  const stopStreaming = useCallback(() => {
    const streamId = streamIdRef.current;
    if (streamId) api.stopStream(streamId).catch(() => {});
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  /** Retry the last user turn on a specific model (used by the switch banner). */
  const retryWithModel = useCallback(
    (modelId) => {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUser) return;
      selectModel(modelId);
      setMessages((prev) => prev.slice(0, prev.findIndex((m) => msgId(m) === msgId(lastUser))));
      setTimeout(() => sendMessage(lastUser.content), 0);
    },
    [messages, selectModel, sendMessage]
  );

  /**
   * Regenerate the last assistant reply.
   *
   * A real endpoint now, rather than resending the user's text: the server
   * rewinds the thread so the model does not see its own previous answer as
   * context, which a client-side resend could not guarantee.
   */
  const regenerate = useCallback(async () => {
    if (isStreaming) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && !m.error);
    if (!lastAssistant) return;

    const targetId = msgId(lastAssistant);
    setNotice(null);
    patchMessage(targetId, { isStreaming: true, content: "", reasoning: "" });
    setIsStreaming(true);

    try {
      const result = await api.regenerate({
        threadId: currentThreadId,
        messageId: targetId,
        settings,
      });
      setMessages((prev) =>
        prev.map((m) => (msgId(m) === targetId ? { ...toUiMessage(result.message) } : m))
      );
    } catch (err) {
      patchMessage(targetId, { isStreaming: false, error: true });
      setNotice({ type: "error", message: err.message, kind: err.kind, traceId: err.traceId });
    } finally {
      setIsStreaming(false);
      refreshThreads();
    }
  }, [messages, currentThreadId, settings, isStreaming, patchMessage, refreshThreads]);

  /** Edit a user message: truncate from it and resend the new text. */
  const editMessage = useCallback(
    (id, newText) => {
      if (!newText.trim()) return;
      const idx = messages.findIndex((m) => msgId(m) === id);
      if (idx === -1) return;
      setMessages((prev) => prev.slice(0, idx));
      setTimeout(() => sendMessage(newText), 0);
    },
    [messages, sendMessage]
  );

  /**
   * Continue a reply that stopped at the output limit.
   *
   * Extends the existing message rather than sending "Continue." as a new turn:
   * the old approach added a user message the user never wrote, and produced
   * two assistant turns where there should be one.
   */
  const continueGenerating = useCallback(async () => {
    if (isStreaming) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    const targetId = msgId(lastAssistant);
    setIsStreaming(true);
    try {
      const result = await api.continueMessage({
        threadId: currentThreadId,
        messageId: targetId,
        settings,
      });
      setMessages((prev) =>
        prev.map((m) => (msgId(m) === targetId ? { ...toUiMessage(result.message) } : m))
      );
    } catch (err) {
      setNotice({ type: "error", message: err.message, kind: err.kind, traceId: err.traceId });
    } finally {
      setIsStreaming(false);
    }
  }, [messages, currentThreadId, settings, isStreaming]);

  /** Whether the last reply can be continued — drives the Continue affordance. */
  const canContinue = useMemo(() => {
    const last = messages.at(-1);
    return Boolean(last?.role === "assistant" && last.finishReason === "length" && !isStreaming);
  }, [messages, isStreaming]);

  const pinMessage = useCallback(
    async (messageId, pinned) => {
      patchMessage(messageId, { pinned });
      try {
        await api.pinMessage(currentThreadId, messageId, pinned);
      } catch (err) {
        patchMessage(messageId, { pinned: !pinned });
        console.error("Failed to pin message:", err.message);
      }
    },
    [currentThreadId, patchMessage]
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  const value = {
    // threads
    threads,
    threadsLoading,
    currentThreadId,
    selectThread,
    startNewChat,
    deleteThread,
    renameThread,
    pinThread,
    archiveThread,
    duplicateThread,
    shareThread,
    refreshThreads,
    // conversation
    messages,
    sendMessage,
    stopStreaming,
    isStreaming,
    searchQuery,
    setSearchQuery,
    // workspace
    catalog,
    providers,
    activeModel,
    settings,
    updateSettings,
    selectModel,
    refreshCatalog,
    // message actions
    retryWithModel,
    regenerate,
    editMessage,
    continueGenerating,
    canContinue,
    pinMessage,
    // notices
    notice,
    setNotice,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/**
 * API message → UI message.
 *
 * The API calls it `createdAt`; the components have always read `timestamp`.
 * `context` and `routing` come through untouched — they are the glass-box
 * material an inspector will render.
 */
function toUiMessage(m) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model,
    provider: m.provider,
    pinned: m.pinned,
    finishReason: m.finishReason,
    usage: m.usage,
    context: m.context,
    routing: m.routing,
    timestamp: m.createdAt,
  };
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}
