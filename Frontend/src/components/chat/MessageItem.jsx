import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { msgId } from "../../utils/format";
import { markdownComponents } from "./markdown";
import { useChat } from "../../context/ChatContext";
import MessageActions from "./nav/MessageActions";

/**
 * One conversation turn. Users get a right-aligned bubble (editable in place);
 * the assistant gets full-width prose with a hover action row.
 */
function MessageItem({ message, searchQuery }) {
  const { regenerate, editMessage } = useChat();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  const id = msgId(message);
  const isUser = message.role === "user";
  const pending = !isUser && message.content === "";

  if (isUser) {
    return (
      <div className="cg-turn cg-turn--user" id={`msg-${id}`}>
        <div className="w-full max-w-[70%]">
          {editing ? (
            <div className="rounded-[22px] bg-elevated p-3">
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(8, draft.split("\n").length)}
                className="w-full resize-none bg-transparent text-primary focus:outline-none"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  className="rounded-full px-3 py-1 text-sm text-secondary hover:bg-hover"
                  onClick={() => { setEditing(false); setDraft(message.content); }}
                >
                  Cancel
                </button>
                <button
                  className="rounded-full bg-white px-3 py-1 text-sm text-[#0d0d0d] disabled:opacity-50"
                  disabled={!draft.trim()}
                  onClick={() => { setEditing(false); editMessage(id, draft); }}
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="cg-bubble">{message.content}</div>
              <MessageActions role="user" text={message.content} onEdit={() => { setDraft(message.content); setEditing(true); }} />
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="cg-turn cg-turn--assistant" id={`msg-${id}`}>
      <div className="cg-assistant-head">
        <span className="cg-assistant-avatar" aria-hidden="true">
          <SparkleLogo />
        </span>
        <span className="cg-assistant-name">NovaGPT</span>
      </div>

      <div className="cg-answer">
        {pending ? (
          <span className="cg-thinking" aria-label="Generating response">
            <span />
            <span />
            <span />
          </span>
        ) : (
          <>
            <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={markdownComponents(searchQuery)}>
              {message.content}
            </ReactMarkdown>
            {message.isStreaming && <span className="cg-cursor" />}
          </>
        )}
      </div>

      {!pending && !message.isStreaming && (
        <MessageActions role="assistant" text={message.content} onRegenerate={regenerate} />
      )}
    </div>
  );
}

/** The rounded ChatGPT-style mark used as the assistant avatar. */
function SparkleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2c.5 3.7 2.3 5.5 6 6-3.7.5-5.5 2.3-6 6-.5-3.7-2.3-5.5-6-6 3.7-.5 5.5-2.3 6-6Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default memo(MessageItem);
