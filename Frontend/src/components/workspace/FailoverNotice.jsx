import { ArrowLeftRight, AlertTriangle } from "lucide-react";
import { useChat } from "../../context/ChatContext";

/**
 * Router failover / provider error banner above the composer.
 * A switch is never silent — the user can continue, switch back, or choose
 * another model.
 */
export default function FailoverNotice({ onOpenModels }) {
  const { notice, setNotice, retryWithModel } = useChat();
  if (!notice) return null;

  const isSwitch = notice.type === "switch";
  const isConfirm = notice.type === "confirm";
  const dismiss = () => setNotice(null);

  return (
    <div
      className={`cg-notice ${notice.type === "error" ? "cg-notice--error" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="cg-notice-icon">
        {isSwitch ? <ArrowLeftRight size={16} /> : <AlertTriangle size={16} />}
      </span>

      <div className="cg-notice-body">
        <span>
          {isConfirm && notice.suggestion
            ? `${notice.message} Switch to ${notice.suggestion.name}?`
            : notice.message}
        </span>

        <div className="cg-notice-actions">
          {isSwitch && (
            <>
              <button className="cg-notice-btn" onClick={dismiss}>Continue</button>
              <button
                className="cg-notice-btn"
                onClick={() => {
                  retryWithModel(notice.from.id);
                  dismiss();
                }}
              >
                Switch back
              </button>
            </>
          )}
          {isConfirm && notice.suggestion && (
            <button
              className="cg-notice-btn"
              onClick={() => {
                retryWithModel(notice.suggestion.id);
                dismiss();
              }}
            >
              Use {notice.suggestion.name}
            </button>
          )}
          <button
            className="cg-notice-btn"
            onClick={() => {
              onOpenModels?.();
              dismiss();
            }}
          >
            Choose model
          </button>
        </div>
      </div>
    </div>
  );
}
