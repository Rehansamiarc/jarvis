"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Small markdown renderer for assistant output.
 *
 * Deliberately not a dependency: chat output needs headings, lists, code fences, links,
 * quotes and emphasis — and nothing else. Being able to reason about every escape is
 * worth more here than a general-purpose parser, and it keeps untrusted model output
 * from reaching `dangerouslySetInnerHTML` (React escapes everything below).
 */

function inline(text: string, keyPrefix = ""): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: code spans first so their contents are never re-processed.
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(https?:\/\/[^\s)>"']+)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="text-arc/90">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (/^https?:\/\//.test(token)) {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noopener noreferrer nofollow ugc">
          {token.replace(/^https?:\/\//, "").slice(0, 60)}
          {token.length > 60 ? "…" : ""}
        </a>
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export default function Markdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  let listItems: { ordered: boolean; items: string[] } | null = null;
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    paragraph = [];
    if (text) blocks.push(<p key={`p${key++}`}>{inline(text, `p${key}`)}</p>);
  };

  const flushList = () => {
    if (!listItems) return;
    const { ordered, items } = listItems;
    listItems = null;
    const Tag = ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={`l${key++}`} className={ordered ? "list-decimal" : "list-disc"}>
        {items.map((item, idx) => (
          <li key={idx}>{inline(item, `li${key}-${idx}`)}</li>
        ))}
      </Tag>
    );
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code
    if (/^```/.test(line.trim())) {
      flushParagraph();
      flushList();
      const lang = line.trim().replace(/^```/, "").trim();
      const buffer: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buffer.push(lines[i]);
        i++;
      }
      blocks.push(
        <pre key={`c${key++}`} data-lang={lang || undefined}>
          <code>{buffer.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const Tag = (`h${Math.min(level + 1, 6)}`) as "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={`h${key++}`}>{inline(heading[2], `h${key}`)}</Tag>);
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      const buffer: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buffer.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      i--;
      blocks.push(<blockquote key={`q${key++}`}>{inline(buffer.join(" "), `q${key}`)}</blockquote>);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      const text = (bullet ? bullet[1] : ordered![2]).trim();
      if (!listItems || listItems.ordered !== isOrdered) {
        flushList();
        listItems = { ordered: isOrdered, items: [] };
      }
      listItems.items.push(text);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  return <div className="markdown">{blocks.map((b, idx) => <Fragment key={idx}>{b}</Fragment>)}</div>;
}
