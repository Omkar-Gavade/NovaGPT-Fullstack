import { useEffect, useRef } from "react";
import { useChat } from "../../context/ChatContext";
import { msgId } from "../../utils/format";
import MessageItem from "./MessageItem";
import EmptyState from "./EmptyState";

/** Conversation scroller. Sticks to the bottom while a reply streams in. */
export default function ChatMessages() {
  const { messages, searchQuery } = useChat();
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="cg-scroll" ref={scrollRef}>
      {messages.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="cg-thread">
          {messages.map((message) => {
            const id = msgId(message);
            if (!id) return null;
            return <MessageItem key={id} message={message} searchQuery={searchQuery} />;
          })}
        </div>
      )}
    </div>
  );
}
