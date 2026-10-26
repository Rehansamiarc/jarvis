"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAsyncEffect } from "@/hooks/useAsyncEffect";
import SparkOrb from "@/components/SparkOrb";
import { useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  Loader2,
  Mic,
  MicOff,
  Plus,
  Send,
  Square,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import { errorMessage, get, post } from "@/lib/client/api";
import Markdown from "@/components/Markdown";
import { Badge, timeAgo } from "@/components/ui";
import { useVoice } from "@/hooks/useVoice";

interface Conversation {
  id: string;
  title: string;
  last_message_at: string | null;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: {
    run_id?: string;
    loaded_tools?: string[];
    steps?: Array<{ tool: string; status: string; detail?: string; durationMs?: number; verified?: boolean }>;
  } | null;
  created_at: string;
}

interface RunResponse {
  conversationId: string;
  reply: string;
  runId: string;
  steps: Array<{ tool: string; status: string; detail?: string; durationMs?: number; verified?: boolean }>;
  pendingAction: { id: string; title: string; risk: string; preview: Record<string, unknown> } | null;
  toolCallCount: number;
  finishReason: string;
}

export default function Chat() {
  const params = useSearchParams();
  const initialConversation = params.get("c");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialConversation);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [prefs, setPrefs] = useState<{
    voice_enabled: boolean;
    speech_rate: number;
    speech_pitch: number;
    language: string;
    wake_word_enabled: boolean;
    voice_name: string | null;
  } | null>(null);
  const [voiceWanted, setVoiceWanted] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);

  // ---------------------------------------------------------------- data loading
  const loadConversations = useCallback(async () => {
    try {
      const res = await get<{ conversations: Conversation[] }>("/api/conversations");
      setConversations(res.conversations);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const res = await get<{ messages: Message[] }>(`/api/conversations/${conversationId}`);
      setMessages(res.messages.filter((m) => m.role !== "tool"));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useAsyncEffect(loadConversations);

  useEffect(() => {
    get<{ preferences: Record<string, unknown> | null }>("/api/preferences")
      .then((res) => {
        const p = res.preferences as Record<string, unknown> | null;
        if (p) {
          setPrefs({
            voice_enabled: Boolean(p.voice_enabled),
            speech_rate: Number(p.speech_rate ?? 1),
            speech_pitch: Number(p.speech_pitch ?? 1),
            language: String(p.language ?? "en-US"),
            wake_word_enabled: Boolean(p.wake_word_enabled),
            voice_name: (p.voice_name as string | null) ?? null,
          });
        }
      })
      .catch(() => undefined);
  }, []);

  // Switching conversations (or starting a new one) re-syncs the transcript.
  const syncTranscript = useCallback(async () => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    await loadMessages(activeId);
  }, [activeId, loadMessages]);
  useAsyncEffect(syncTranscript);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // ------------------------------------------------------------------------ voice
  const handleFinalTranscript = useCallback(
    (text: string) => {
      if (!text.trim() || busyRef.current) return;
      setInput((current) => (current ? `${current} ${text}` : text));
    },
    []
  );

  const voice = useVoice({
    lang: prefs?.language ?? "en-US",
    rate: prefs?.speech_rate ?? 1,
    pitch: prefs?.speech_pitch ?? 1,
    voiceName: prefs?.voice_name,
    wakeWordEnabled: prefs?.wake_word_enabled ?? false,
    wakeWord: "jarvis",
    onFinalTranscript: handleFinalTranscript,
    onInterim: () => undefined,
  });

  const voiceActive = voiceWanted && voice.state.supported;

  const toggleVoice = useCallback(() => {
    if (!voice.state.supported) {
      setError(
        "Voice input needs Chrome or Edge (Web Speech API). Everything else works here — type instead, or use voice output only."
      );
      return;
    }
    if (voiceActive) {
      voice.stop();
      setVoiceWanted(false);
    } else {
      voice.stopSpeaking();
      setVoiceWanted(true);
      voice.start();
    }
  }, [voice, voiceActive]);

  // ---------------------------------------------------------------------- sending
  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || busyRef.current) return;

      busyRef.current = true;
      setBusy(true);
      setError(null);
      setInput("");

      const optimistic: Message = {
        id: `local-${Date.now()}`,
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
      };
      setMessages((m) => [...m, optimistic]);

      try {
        const result = await post<RunResponse>("/api/agent/run", {
          message: text,
          conversationId: activeId,
        });

        if (result.conversationId !== activeId) setActiveId(result.conversationId);

        setMessages((m) => [
          ...m,
          {
            id: `assistant-${result.runId}`,
            role: "assistant",
            content: result.reply,
            tool_calls: result.steps.length
              ? { run_id: result.runId, steps: result.steps }
              : null,
            created_at: new Date().toISOString(),
          },
        ]);

        if (voiceWanted && voice.state.supported && result.reply) {
          voice.speak(result.reply);
        }

        loadConversations();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [input, activeId, voice, voiceWanted, loadConversations]
  );

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  async function newConversation() {
    setActiveId(null);
    setMessages([]);
    setSidebarOpen(false);
    setError(null);
  }

  async function removeConversation(id: string) {
    try {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      setConversations((c) => c.filter((x) => x.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const suggestionChips = useMemo(
    () => [
      "Draft a blog post about AI and save it in WordPress",
      "Summarise my recent videos and tell me which topics perform best",
      "Remind me tomorrow at 9 AM to finish my project",
      "What do you remember about my preferences?",
    ],
    []
  );

  return (
    <div className="flex h-[calc(100vh-4.5rem)] gap-3">
      {/* ------------------------------------------------------------ history */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-64 border-r border-line bg-panel p-3 transition-transform lg:static lg:z-auto lg:w-64 lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button className="btn btn-primary mb-3 w-full" onClick={newConversation}>
          <Plus size={15} /> New conversation
        </button>
        <div className="label mb-2">History</div>
        <div className="space-y-1 overflow-y-auto" style={{ maxHeight: "calc(100vh - 12rem)" }}>
          {conversations.length === 0 && (
            <p className="text-xs text-faint">No conversations yet.</p>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm ${
                c.id === activeId ? "bg-arc/12 text-arc" : "text-mute hover:bg-white/5 hover:text-ink"
              }`}
            >
              <button
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => {
                  setActiveId(c.id);
                  setSidebarOpen(false);
                }}
                title={c.title}
              >
                {c.title}
              </button>
              <button
                className="opacity-0 transition group-hover:opacity-60 hover:!opacity-100"
                onClick={() => removeConversation(c.id)}
                aria-label={`Delete ${c.title}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-20 bg-black/60 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* ------------------------------------------------------------ messages */}
      <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-line bg-panel/60">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <button
            className="rounded-md p-1 text-mute hover:text-ink lg:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Show history"
          >
            <ChevronLeft size={18} />
          </button>

          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${
                voice.state.speaking ? "bg-gold status-pulse" : voiceActive && voice.state.listening ? "bg-arc status-pulse" : "bg-ok"
              }`}
            />
            <span className="text-xs text-mute">
              {voice.state.speaking
                ? "speaking"
                : voiceActive && voice.state.listening
                  ? prefs?.wake_word_enabled
                    ? `listening for “JARVIS”`
                    : "listening"
                  : "idle"}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => {
                if (voice.state.speaking) voice.stopSpeaking();
                else voice.speak(messages.at(-1)?.content ?? "Hello. JARVIS is ready.");
              }}
              className="rounded-md p-2 text-mute transition hover:text-arc"
              aria-label="Read last reply aloud"
              title="Read the last reply aloud"
            >
              {voice.state.speaking ? <VolumeX size={16} /> : <Volume2 size={16} />}
            </button>
            <button
              onClick={toggleVoice}
              className={`rounded-md p-2 transition ${
                voiceActive ? "bg-arc/15 text-arc" : "text-mute hover:text-ink"
              }`}
              aria-label={voiceActive ? "Stop voice mode" : "Start voice mode"}
              title={
                voice.state.supported
                  ? voiceActive
                    ? "Voice mode active — click to stop"
                    : "Start voice mode (only listens while active)"
                  : "Speech recognition is not available in this browser"
              }
            >
              {voiceActive ? <Mic size={16} /> : <MicOff size={16} />}
            </button>
          </div>
        </div>

        {voice.state.error && (
          <div className="border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-[#ffb9c6]">
            {voice.state.error}
          </div>
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          {messages.length === 0 ? (
            <div className="mx-auto mt-2 max-w-2xl text-center">
              <div className="relative mx-auto h-[clamp(200px,34vh,300px)] w-full max-w-[360px]">
                <SparkOrb
                  state={voice.state.speaking ? "speaking" : voice.state.listening ? "listening" : busy ? "thinking" : "idle"}
                />
              </div>
              <p className="mt-1 text-[0.6rem] uppercase tracking-[0.42em] text-faint">
                jarvis online
              </p>
              <p className="mx-auto mt-3 max-w-lg text-sm text-mute">
                Ask anything. JARVIS can search your memory and knowledge base, manage tasks and
                reminders, and — with your approval — act through connected services.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {suggestionChips.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="rounded-full border border-line2 px-3 py-1.5 text-xs text-mute transition hover:border-arc-dim hover:text-arc"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {busy && (
                <div className="flex items-center gap-2 text-sm text-mute">
                  <Loader2 size={14} className="animate-spin text-arc" />
                  JARVIS is working…
                  <div className="flex items-end gap-0.5">
                    {[0, 1, 2, 3].map((i) => (
                      <span
                        key={i}
                        className="wave-bar block h-3 w-1 bg-arc/70"
                        style={{ animationDelay: `${i * 120}ms` }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* live caption while recognising */}
        {voiceActive && voice.state.interim && (
          <div className="border-t border-line bg-void/60 px-4 py-2 text-sm italic text-arc/80">
            {voice.state.interim}
          </div>
        )}

        <div className="border-t border-line px-3 py-3">
          {error && (
            <div className="mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-[#ffb9c6]">
              {error}
            </div>
          )}
          <div className="flex items-end gap-2">
            <button
              onClick={toggleVoice}
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg border transition ${
                voiceActive
                  ? "border-arc/50 bg-arc/15 text-arc"
                  : "border-line2 text-mute hover:border-arc-dim hover:text-arc"
              }`}
              aria-label="Toggle voice mode"
            >
              {voiceActive ? <Square size={16} /> : <Mic size={16} />}
            </button>
            <textarea
              className="input min-h-[42px] max-h-40 flex-1"
              rows={1}
              placeholder={
                voiceActive
                  ? prefs?.wake_word_enabled
                    ? "Listening for “JARVIS”… you can also type"
                    : "Listening… you can also type"
                  : "Message JARVIS  ·  Enter to send, Shift+Enter for a new line"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              className="btn btn-primary h-10 w-10 shrink-0 !p-0"
              aria-label="Send message"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const steps = message.tool_calls?.steps ?? [];

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-arc/30 bg-arc/10 px-4 py-2.5 text-sm text-ink">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {steps.length > 0 && (
        <details className="w-full rounded-lg border border-line bg-void/50 px-3 py-2 text-xs">
          <summary className="cursor-pointer select-none text-mute">
            Tool activity ({steps.length}) —{" "}
            {steps.filter((s) => s.status === "ok").length} succeeded
          </summary>
          <ul className="mt-2 space-y-1">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="font-mono text-arc">{s.tool}</span>
                <Badge
                  tone={
                    s.status === "ok"
                      ? "ok"
                      : s.status === "awaiting_approval"
                        ? "warn"
                        : s.status === "rejected"
                          ? "neutral"
                          : "danger"
                  }
                >
                  {s.status}
                </Badge>
                {s.verified && <Badge tone="info">verified</Badge>}
                {s.detail && <span className="min-w-0 flex-1 break-words text-faint">{s.detail}</span>}
                {typeof s.durationMs === "number" && (
                  <span className="ml-auto shrink-0 text-faint">{s.durationMs}ms</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="max-w-[92%] text-sm text-ink">
        <Markdown content={message.content} />
      </div>
      <span className="text-[10px] text-faint">{timeAgo(message.created_at)}</span>
    </div>
  );
}
