"use client";

import { useCallback, useEffect, useState } from "react";
import { useAsyncEffect } from "@/hooks/useAsyncEffect";
import { Database, FileText, Link2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { del, errorMessage, get, post } from "@/lib/client/api";
import { Badge, EmptyState, PageHeader, Spinner, timeAgo } from "@/components/ui";

interface Document {
  id: string;
  source_type: string;
  title: string;
  uri: string | null;
  status: string;
  error: string | null;
  chunk_count: number;
  byte_size: number | null;
  last_indexed_at: string | null;
  updated_at: string;
}

interface Hit {
  id: string;
  document_id: string;
  content: string;
  title?: string;
  similarity: number;
}

/**
 * Personal knowledge base (section F-C): index notes and approved URLs, hybrid-search
 * them, re-index after a change, or delete. Retrieval answers always carry the source
 * document so a citation can be checked.
 */
export default function KnowledgePage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", content: "", url: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<{ documents: Document[] }>("/api/knowledge");
      setDocuments(res.documents);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useAsyncEffect(load);

  useEffect(() => {
    if (!query.trim()) return;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await get<{ chunks: Hit[] }>(
          `/api/knowledge?q=${encodeURIComponent(query.trim())}`
        );
        setHits(res.chunks);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  async function index() {
    if (!form.title.trim()) return setError("A title is required.");
    if (!form.content.trim() && !form.url.trim()) return setError("Provide content or a URL.");
    setBusy(true);
    setError(null);
    try {
      await post("/api/knowledge", {
        title: form.title.trim(),
        content: form.content.trim() || undefined,
        url: form.url.trim() || undefined,
      });
      setForm({ title: "", content: "", url: "" });
      setAdding(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function reindex(id: string) {
    setBusy(true);
    try {
      await post(`/api/knowledge/${id}`);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await del(`/api/knowledge/${id}`);
      setDocuments((d) => d.filter((x) => x.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div>
      <PageHeader
        title="Knowledge"
        subtitle="Documents JARVIS can quote from. Content is chunked, embedded with pgvector and searched with hybrid semantic + keyword retrieval — isolated to your account by Row Level Security."
        actions={
          <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
            <Plus size={15} /> Add document
          </button>
        }
      />

      <div className="relative mb-4">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <input
          className="input pl-9"
          placeholder="Search the knowledge base…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Clearing results belongs to the typing event, not to the debounce effect.
            if (!e.target.value.trim()) setHits(null);
          }}
        />
        {searching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-arc">searching…</span>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#ffb9c6]">
          {error}
        </div>
      )}

      {adding && (
        <div className="panel mb-4 p-4">
          <div className="label mb-3">Index a document</div>
          <input
            className="input mb-2"
            placeholder="Title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <input
            className="input mb-2"
            placeholder="https://example.com/article (optional — fetched server-side and stripped to text)"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
          />
          <textarea
            className="input mb-3"
            rows={5}
            placeholder="…or paste text directly"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
          />
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={index} disabled={busy}>
              {busy && <RefreshCw size={14} className="animate-spin" />} Index
            </button>
            <button className="btn btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {hits !== null ? (
        hits.length === 0 ? (
          <EmptyState title="No matching passages" hint="Try different wording — semantic search matches meaning, not just keywords." />
        ) : (
          <div className="space-y-3">
            <p className="label">{hits.length} passage(s)</p>
            {hits.map((h) => (
              <article key={h.id} className="panel p-4">
                <div className="mb-2 flex items-center gap-2">
                  <FileText size={14} className="text-arc" />
                  <span className="text-sm font-medium text-white">{h.title ?? "Untitled"}</span>
                  <Badge tone="info">{(h.similarity * 100).toFixed(0)}% match</Badge>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-mute">{h.content}</p>
              </article>
            ))}
          </div>
        )
      ) : loading ? (
        <Spinner label="Loading documents…" />
      ) : documents.length === 0 ? (
        <EmptyState
          title="No documents indexed yet"
          hint="Add notes or a URL so JARVIS can quote your own material instead of guessing."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {documents.map((d) => (
            <article key={d.id} className="panel p-4">
              <div className="mb-2 flex items-start gap-2">
                <span className="mt-0.5 text-arc">
                  {d.source_type === "url" ? <Link2 size={15} /> : <FileText size={15} />}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-semibold text-white">{d.title}</h3>
                  {d.uri && (
                    <a
                      href={d.uri}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="truncate text-xs text-arc hover:underline"
                    >
                      {d.uri}
                    </a>
                  )}
                </div>
                <Badge
                  tone={d.status === "indexed" ? "ok" : d.status === "failed" ? "danger" : "warn"}
                >
                  {d.status}
                </Badge>
              </div>

              {d.error && <p className="mb-2 text-xs text-[#ffb9c6]">{d.error}</p>}

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
                <Database size={11} />
                <span>{d.chunk_count} chunks</span>
                <span>· {d.byte_size ? `${Math.round(d.byte_size / 1024)} KB` : "—"}</span>
                <span>· {timeAgo(d.last_indexed_at ?? d.updated_at)}</span>
                <div className="ml-auto flex gap-2">
                  <button
                    className="text-arc hover:underline disabled:opacity-50"
                    onClick={() => reindex(d.id)}
                    disabled={busy}
                  >
                    Re-index
                  </button>
                  <button
                    className="text-faint transition hover:text-danger"
                    onClick={() => remove(d.id)}
                    aria-label={`Delete ${d.title}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
