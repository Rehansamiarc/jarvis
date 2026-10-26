"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Download, Pin, Plus, Search, Trash2 } from "lucide-react";
import { del, errorMessage, get, patch, post } from "@/lib/client/api";
import { Badge, EmptyState, PageHeader, Spinner, timeAgo } from "@/components/ui";

interface Memory {
  id: string;
  kind: string;
  title: string;
  content: string;
  confidence: number;
  pinned: boolean;
  source?: string;
  created_at: string;
  updated_at: string;
}

const KINDS = ["preference", "fact", "project", "date", "goal", "instruction", "other"] as const;

/**
 * Memory management (section 4 / D): inspect, search, edit, pin, add and delete.
 * Everything here is RLS-scoped, and the export button produces a plain JSON copy the
 * user actually owns.
 */
export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [form, setForm] = useState({ title: "", content: "", kind: "fact" as string });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (kind) params.set("kind", kind);
      const res = await get<{ memories: Memory[] }>(`/api/memories?${params}`);
      setMemories(res.memories);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [query, kind]);

  useEffect(() => {
    const t = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  async function save() {
    if (!form.title.trim() || !form.content.trim()) {
      setError("Both a title and content are required.");
      return;
    }
    try {
      if (editing) {
        await patch(`/api/memories/${editing.id}`, {
          title: form.title,
          content: form.content,
          kind: form.kind,
        });
      } else {
        await post("/api/memories", form);
      }
      setAdding(false);
      setEditing(null);
      setForm({ title: "", content: "", kind: "fact" });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(id: string) {
    try {
      await del(`/api/memories/${id}`);
      setMemories((m) => m.filter((x) => x.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function togglePin(m: Memory) {
    try {
      await patch(`/api/memories/${m.id}`, { pinned: !m.pinned });
      setMemories((list) => list.map((x) => (x.id === m.id ? { ...x, pinned: !x.pinned } : x)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function exportAll() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), memories }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jarvis-memories-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <PageHeader
        title="Memory"
        subtitle="Long-term facts JARVIS keeps between conversations. Edit anything that is wrong — retrieval only ever uses what is stored here."
        actions={
          <>
            <button className="btn btn-ghost" onClick={exportAll} title="Download as JSON">
              <Download size={15} /> Export
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setEditing(null);
                setForm({ title: "", content: "", kind: "fact" });
                setAdding(true);
              }}
            >
              <Plus size={15} /> New memory
            </button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            className="input pl-9"
            placeholder="Semantic search across memories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-[#ffb9c6]">{error}</div>}

      {(adding || editing) && (
        <div className="panel mb-4 p-4">
          <div className="label mb-3">{editing ? "Edit memory" : "New memory"}</div>
          <input
            className="input mb-2"
            placeholder="Title — e.g. 'Prefers concise answers'"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <textarea
            className="input mb-2"
            rows={4}
            placeholder="What should JARVIS remember?"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
          />
          <div className="flex items-center gap-2">
            <select
              className="input w-auto"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" onClick={save}>
              Save
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setAdding(false);
                setEditing(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <Spinner label="Loading memories…" />
      ) : memories.length === 0 ? (
        <EmptyState
          title={query ? "No memories matched that search" : "No memories stored yet"}
          hint={
            query
              ? "Try a broader phrase — retrieval blends semantic and keyword matching."
              : "Tell JARVIS something worth keeping: “remember that I prefer …” and it will be saved here."
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {memories.map((m) => (
            <article key={m.id} className="panel p-4">
              <div className="mb-2 flex items-start gap-2">
                <Badge tone={m.pinned ? "info" : "neutral"}>{m.kind}</Badge>
                <h3 className="min-w-0 flex-1 text-sm font-semibold text-white">{m.title}</h3>
                <button
                  className={m.pinned ? "text-arc" : "text-faint hover:text-arc"}
                  onClick={() => togglePin(m)}
                  title={m.pinned ? "Unpin" : "Pin"}
                >
                  <Pin size={14} />
                </button>
                <button
                  className="text-faint transition hover:text-danger"
                  onClick={() => remove(m.id)}
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm text-mute">{m.content}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-faint">
                <Brain size={11} />
                <span>{timeAgo(m.updated_at)}</span>
                <span>· confidence {Number(m.confidence).toFixed(2)}</span>
                <button
                  className="ml-auto text-arc hover:underline"
                  onClick={() => {
                    setEditing(m);
                    setForm({ title: m.title, content: m.content, kind: m.kind });
                    setAdding(false);
                  }}
                >
                  Edit
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
