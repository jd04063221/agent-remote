import React, { useMemo, useState } from "react";
import {
  parseMarkdownBlocks,
  type MdBlock,
  type MdInline,
  type TableAlign,
} from "./markdown";

interface MarkdownContentProps {
  content: string;
  className?: string;
  copyLabel?: string;
  copiedLabel?: string;
}

function CodeBlockView({
  lang,
  code,
  copyLabel,
  copiedLabel,
}: {
  lang: string;
  code: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    try {
      void navigator.clipboard?.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore clipboard errors in restricted contexts
    }
  };

  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || "text"}</span>
        <button type="button" className="md-code-copy" onClick={handleCopy}>
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      <pre className="md-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderInlines(nodes: MdInline[], keyPrefix: string): React.ReactNode[] {
  return nodes.map((node, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (node.type) {
      case "text":
        return <React.Fragment key={key}>{node.text}</React.Fragment>;
      case "br":
        return <br key={key} />;
      case "code":
        return (
          <code key={key} className="md-inline-code">
            {node.text}
          </code>
        );
      case "strong":
        return <strong key={key}>{renderInlines(node.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInlines(node.children, key)}</em>;
      case "del":
        return <del key={key}>{renderInlines(node.children, key)}</del>;
      case "link":
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="md-link"
          >
            {renderInlines(node.children, key)}
          </a>
        );
    }
  });
}

function alignStyle(align: TableAlign | undefined): React.CSSProperties | undefined {
  if (!align) return undefined;
  return { textAlign: align };
}

function renderBlocks(
  blocks: MdBlock[],
  keyPrefix: string,
  copyLabel: string,
  copiedLabel: string,
): React.ReactNode[] {
  return blocks.map((block, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (block.type) {
      case "heading": {
        const children = renderInlines(block.children, key);
        const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
        return (
          <Tag key={key} className={`md-h md-h${block.level}`}>
            {children}
          </Tag>
        );
      }
      case "paragraph":
        return (
          <p key={key} className="md-p">
            {renderInlines(block.children, key)}
          </p>
        );
      case "code":
        return (
          <CodeBlockView
            key={key}
            lang={block.lang}
            code={block.code}
            copyLabel={copyLabel}
            copiedLabel={copiedLabel}
          />
        );
      case "blockquote":
        return (
          <blockquote
            key={key}
            className={block.alert ? `md-quote md-alert md-alert-${block.alert}` : "md-quote"}
          >
            {block.alert && <div className="md-alert-title">{block.alert.toUpperCase()}</div>}
            {renderBlocks(block.children, key, copyLabel, copiedLabel)}
          </blockquote>
        );
      case "list": {
        const ListTag = block.ordered ? "ol" : "ul";
        return (
          <ListTag
            key={key}
            className={block.ordered ? "md-ol" : "md-ul"}
            start={block.ordered && block.start !== 1 ? block.start : undefined}
          >
            {block.items.map((item, itemIdx) => {
              const itemKey = `${key}-i${itemIdx}`;
              return (
                <li
                  key={itemKey}
                  className={item.checked !== undefined ? "md-task-item" : undefined}
                >
                  {item.checked !== undefined && (
                    <input
                      type="checkbox"
                      className="md-task-box"
                      checked={item.checked}
                      readOnly
                      tabIndex={-1}
                    />
                  )}
                  <span className="md-li-body">
                    {renderInlines(item.inline, itemKey)}
                    {item.children.length > 0 &&
                      renderBlocks(item.children, `${itemKey}-sub`, copyLabel, copiedLabel)}
                  </span>
                </li>
              );
            })}
          </ListTag>
        );
      }
      case "table":
        return (
          <div key={key} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {block.headers.map((cell, cIdx) => (
                    <th key={`${key}-h${cIdx}`} style={alignStyle(block.alignments[cIdx])}>
                      {renderInlines(cell, `${key}-h${cIdx}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rIdx) => (
                  <tr key={`${key}-r${rIdx}`}>
                    {row.map((cell, cIdx) => (
                      <td key={`${key}-r${rIdx}-c${cIdx}`} style={alignStyle(block.alignments[cIdx])}>
                        {renderInlines(cell, `${key}-r${rIdx}-c${cIdx}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "hr":
        return <hr key={key} className="md-hr" />;
    }
  });
}

export const MarkdownContent = React.memo(function MarkdownContent({
  content,
  className,
  copyLabel = "Copy",
  copiedLabel = "Copied",
}: MarkdownContentProps) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);
  return (
    <div className={className ? `md-content ${className}` : "md-content"}>
      {renderBlocks(blocks, "b", copyLabel, copiedLabel)}
    </div>
  );
});
