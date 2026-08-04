import { Fragment } from "react";
import CodeBlock from "./CodeBlock";

/** Wrap search matches in <mark> without disturbing markdown structure. */
function highlight(children, query) {
  if (!query) return children;
  return (Array.isArray(children) ? children : [children]).map((child, i) => {
    if (typeof child !== "string") return <Fragment key={i}>{child}</Fragment>;
    const parts = child.split(new RegExp(`(${escapeRegExp(query)})`, "gi"));
    return parts.map((part, j) =>
      part.toLowerCase() === query.toLowerCase() ? (
        <mark key={`${i}-${j}`}>{part}</mark>
      ) : (
        <Fragment key={`${i}-${j}`}>{part}</Fragment>
      )
    );
  });
}

const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** react-markdown overrides: fenced code -> CodeBlock, inline code -> pill. */
export function markdownComponents(query) {
  const hl = (props) => highlight(props.children, query);
  return {
    p: (props) => <p {...props}>{hl(props)}</p>,
    li: (props) => <li {...props}>{hl(props)}</li>,
    strong: (props) => <strong {...props}>{hl(props)}</strong>,
    em: (props) => <em {...props}>{hl(props)}</em>,
    pre: (props) => <CodeBlock {...props} />,
    code: ({ className, children, ...props }) =>
      /language-/.test(className || "") ? (
        <code className={className} {...props}>
          {children}
        </code>
      ) : (
        <code className="cg-inline-code" {...props}>
          {children}
        </code>
      ),
  };
}
