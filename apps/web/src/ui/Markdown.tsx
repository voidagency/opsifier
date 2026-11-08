import { Fragment, type ReactNode } from "react";

/**
 * The small part of Markdown that notes need, turned into React elements. Nothing is passed through
 * as HTML, so a note can never inject markup, and only http, https and mailto links are made live.
 */
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string };

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)\s]+\))/g;
const SAFE_LINK = /^(?:https?:|mailto:)/i;

function renderPart(part: string, key: number): ReactNode {
  if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
    return (
      <code key={key} className="font-mono text-xs">
        {part.slice(1, -1)}
      </code>
    );
  }
  if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
    return <strong key={key}>{part.slice(2, -2)}</strong>;
  }
  if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
    return part.length > 2 ? <em key={key}>{part.slice(1, -1)}</em> : part;
  }
  const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
  if (link !== null) {
    const [, label, href] = link;
    return href !== undefined && SAFE_LINK.test(href) ? (
      <a
        key={key}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="underline underline-offset-4"
      >
        {label}
      </a>
    ) : (
      part
    );
  }
  return <Fragment key={key}>{part}</Fragment>;
}

function renderInline(text: string): ReactNode[] {
  const parts = text.split(INLINE);
  const nodes: ReactNode[] = [];
  for (const part of parts) {
    nodes.push(renderPart(part, nodes.length));
  }
  return nodes;
}

/** Splits text into headings, lists, code fences and paragraphs. */
export function parseMarkdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      index += 1;
      continue;
    }
    const bullet = /^\s*(?:[-*+]|(\d+)\.)\s+/;
    if (bullet.test(line)) {
      const ordered = bullet.exec(line)?.[1] !== undefined;
      const items: string[] = [];
      while (index < lines.length && bullet.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(bullet, ""));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^(#{1,3}\s|\s*[-*+]\s|\s*\d+\.\s|\s*```)/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

const HEADING_CLASSES = ["text-md font-medium", "text-base font-medium", "text-sm font-medium"];

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Tag = `h${Math.min(block.level + 1, 6)}` as "h2";
      return (
        <Tag key={index} className={HEADING_CLASSES[block.level - 1]}>
          {renderInline(block.text)}
        </Tag>
      );
    }
    case "paragraph":
      return <p key={index}>{renderInline(block.text)}</p>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={index} className={block.ordered ? "ml-4 list-decimal" : "ml-4 list-disc"}>
          {block.items.map((item, itemIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a note's list items have no identity of their own
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    case "code":
      return (
        <pre key={index} className="overflow-x-auto rounded-sm border p-2 font-mono text-xs">
          {block.text}
        </pre>
      );
  }
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ?? "grid gap-2 text-sm"}>{parseMarkdownBlocks(text).map(renderBlock)}</div>
  );
}
