import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Plus, Mic, ArrowUp, Square, Paperclip, Upload, AudioLines } from "lucide-react";
import { useChat } from "../../context/ChatContext";
import { useAttachments } from "../../hooks/useAttachments";
import FailoverNotice from "../workspace/FailoverNotice";
import IconButton from "./ui/IconButton";
import AttachmentChip from "./ui/AttachmentChip";

const ACCEPT =
  ".pdf,.doc,.docx,.txt,.csv,.md,.markdown,.zip,image/*,audio/*,video/*";

/**
 * Premium composer. Auto-grows, accepts drag-drop / paste / picker attachments
 * with live previews, and morphs send ↔ stop while streaming. Wired to the
 * existing ChatContext — no backend logic changes.
 */
export default function ChatInput({ onOpenModels }) {
  const { sendMessage, isStreaming, stopStreaming } = useChat();
  const { items, dragging, addFiles, remove, clear, dropZoneProps, onPaste } = useAttachments();
  const reduce = useReducedMotion();

  const [value, setValue] = useState("");
  const textareaRef = useRef(null);
  const fileRef = useRef(null);

  const grow = (el) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  };

  const canSend = value.trim() && !isStreaming;

  const submit = () => {
    if (!canSend) return;
    sendMessage(value); // attachments are preview-only until the upload endpoint exists
    setValue("");
    clear();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 bg-app px-3 pb-3 sm:px-5 sm:pb-4">
      <FailoverNotice onOpenModels={onOpenModels} />

      <div
        {...dropZoneProps}
        className={`relative mx-auto flex w-full max-w-3xl flex-col rounded-composer bg-elevated
          shadow-[0_0_0_1px_theme(colors.line)] transition-shadow duration-200
          focus-within:shadow-[0_0_0_1px_theme(colors.line-strong)]
          ${dragging ? "shadow-[0_0_0_2px_theme(colors.accent)]" : ""}`}
      >
        {/* drag overlay */}
        <AnimatePresence>
          {dragging && (
            <motion.div
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduce ? undefined : { opacity: 0 }}
              className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-composer
                bg-app/70 backdrop-blur-sm"
            >
              <div className="flex items-center gap-2 text-sm text-primary">
                <Upload size={18} /> Drop files to attach
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* attachment previews */}
        <AnimatePresence initial={false}>
          {items.length > 0 && (
            <motion.div
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduce ? undefined : { height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap gap-2 p-3 pb-0">
                {items.map((item) => (
                  <AttachmentChip key={item.id} item={item} onRemove={remove} />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {/* row 1 — the prompt */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          placeholder="Ask anything"
          aria-label="Message NovaGPT"
          onChange={(e) => {
            setValue(e.target.value);
            grow(e.target);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="max-h-60 w-full resize-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-[16px] leading-6
            text-primary placeholder:text-tertiary focus:outline-none"
        />

        {/* row 2 — controls */}
        <div className="flex items-center justify-between px-2.5 pb-2.5 pt-0.5">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Add photos & files"
            className="grid h-8 w-8 place-items-center rounded-full border border-line text-secondary
              transition-colors hover:bg-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-secondary/60"
          >
            <Plus size={18} />
          </button>

          <div className="flex items-center gap-0.5">
            <IconButton icon={Paperclip} label="Attach file" onClick={() => fileRef.current?.click()} />
            <IconButton icon={Mic} label="Voice input — coming soon" disabled />

            {isStreaming ? (
              <button
                type="button"
                onClick={stopStreaming}
                aria-label="Stop generating"
                className="ml-0.5 grid h-9 w-9 place-items-center rounded-full bg-white text-[#0d0d0d] transition-transform active:scale-95"
              >
                <Square size={16} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={canSend ? submit : undefined}
                disabled={!value.trim() && false}
                aria-label={canSend ? "Send message" : "Voice mode"}
                className={`ml-0.5 grid h-9 w-9 place-items-center rounded-full transition-transform active:scale-95
                  ${canSend ? "bg-white text-[#0d0d0d] hover:scale-[1.04]" : "bg-white text-[#0d0d0d]"}`}
              >
                {canSend ? <ArrowUp size={19} /> : <AudioLines size={18} />}
              </button>
            )}
          </div>
        </div>
      </div>

      <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-tertiary">
        NovaGPT can make mistakes. Check important info.
      </p>
    </div>
  );
}
