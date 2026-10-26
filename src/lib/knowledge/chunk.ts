/**
 * Text splitting for the knowledge base (section F-C).
 *
 * Paragraph-aware rather than fixed-width: retrieval quality drops sharply when a chunk
 * cuts a sentence in half, and RAG answers quote the chunk verbatim. We target ~1000
 * characters with a 150-character overlap so a fact spanning a boundary still matches.
 */

const TARGET_CHARS = 1000;
const OVERLAP_CHARS = 150;
const MIN_CHARS = 120;

export interface Chunk {
  ordinal: number;
  content: string;
  tokenCount: number;
}

export function estimateTokens(text: string): number {
  // ~4 characters per token for English prose — an estimate, and labelled as one.
  return Math.max(1, Math.ceil(text.length / 4));
}

export function splitText(input: string): Chunk[] {
  const text = normalize(input);
  if (!text.trim()) return [];

  // Long single paragraphs (PDF extractions, minified HTML) have no natural break points.
  const paragraphs = text.split(/\n{2,}/).flatMap((p) => hardWrap(p));

  const bodies: string[] = [];
  let buffer = "";

  const flush = (content: string) => {
    const trimmed = content.trim();
    if (trimmed) bodies.push(trimmed);
  };

  for (const para of paragraphs) {
    if (!para.trim()) continue;

    const candidate = buffer ? `${buffer}\n\n${para}` : para;
    if (buffer.length >= MIN_CHARS && candidate.length > TARGET_CHARS) {
      flush(buffer);
      // Carry a tail of the chunk just closed into the next one, so a sentence that spans
      // the boundary is still retrievable from a single chunk.
      const carry = buffer.length > OVERLAP_CHARS ? buffer.slice(-OVERLAP_CHARS).trim() : "";
      buffer = carry ? `${carry}\n\n${para}` : para;
    } else {
      buffer = candidate;
    }
  }
  flush(buffer);

  return bodies.map((content, ordinal) => ({
    ordinal,
    content,
    tokenCount: estimateTokens(content),
  }));
}

function hardWrap(paragraph: string): string[] {
  if (paragraph.length <= TARGET_CHARS * 1.5) return [paragraph];

  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if ((current + " " + s).length > TARGET_CHARS && current) {
      out.push(current.trim());
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
    // A single pathological "sentence" with no punctuation (minified HTML, PDF dumps).
    // Cut at 1.5x rather than 2x so a hard-wrapped piece plus the overlap carry still
    // lands under the ceiling one chunk later.
    while (current.length > TARGET_CHARS * 1.5) {
      out.push(current.slice(0, TARGET_CHARS));
      current = current.slice(TARGET_CHARS);
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown-ish stripping for HTML/README inputs so chunks contain prose, not tags. */
export function stripMarkup(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
