import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/** Code block with a language label and copy button, ChatGPT-style. */
export default function CodeBlock({ children }) {
  const preRef = useRef(null);
  const [copied, setCopied] = useState(false);

  const codeEl = Array.isArray(children) ? children[0] : children;
  const className = codeEl?.props?.className || "";
  const language = /language-(\w+)/.exec(className)?.[1] || "text";

  const copy = () => {
    navigator.clipboard.writeText(preRef.current?.innerText ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="cg-code">
      <div className="cg-code-head">
        <span>{language}</span>
        <button className="cg-code-copy" onClick={copy} aria-label="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="cg-code-body" ref={preRef}>
        {children}
      </pre>
    </div>
  );
}
