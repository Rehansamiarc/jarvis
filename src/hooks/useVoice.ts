"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice interaction using the browser Web Speech API (section 3).
 *
 * HONEST LIMITS — stated here and surfaced in the UI:
 *  * Recognition runs ONLY while voice mode is explicitly active. There is no background
 *    listening, because neither the browser nor the OS permits a web page to do that.
 *  * A wake word ("Jarvis") is recognised only while this active session is running, and
 *    only when the tab is visible. It is not an always-on assistant.
 *  * Interruption (barge-in) works by cancelling speech synthesis as soon as a new
 *    utterance begins — while voice mode is on.
 *
 * Chrome/Edge support `SpeechRecognition`; Firefox and Safari do not. `supported` is
 * reported so the UI can say so instead of silently doing nothing.
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

interface SpeechResultAlternative {
  transcript: string;
}

interface SpeechResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechResultAlternative;
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}

interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as SpeechRecognitionCtor | null;
}

export interface UseVoiceOptions {
  lang: string;
  rate: number;
  pitch: number;
  voiceName?: string | null;
  wakeWordEnabled?: boolean;
  wakeWord?: string;
  /** Called with the finalised transcript of one utterance. */
  onFinalTranscript: (text: string) => void;
  /** Called when interim results change (live caption). */
  onInterim?: (text: string) => void;
  /** When set, speaking this text is automatic — used for JARVIS replies. */
  autoSpeak?: boolean;
}

export interface VoiceState {
  supported: boolean;
  active: boolean;
  listening: boolean;
  speaking: boolean;
  interim: string;
  error: string | null;
  wakeWordDetected: boolean;
}

export function useVoice(options: UseVoiceOptions) {
  const [active, setActive] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wakeWordDetected, setWakeWordDetected] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantsListening = useRef(false);
  const supported = getRecognitionCtor() !== null && typeof window !== "undefined" && "speechSynthesis" in window;

  // The latest options are mirrored into a ref so the speech/recognition callbacks below
  // never have to be rebuilt (rebuilding them would restart recognition mid-utterance).
  // Writing it in an effect keeps the render pure.
  const optsRef = useRef(options);
  useEffect(() => {
    optsRef.current = options;
  }, [options]);

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const clean = text.replace(/```[\s\S]*?```/g, " Code block omitted. ")
      .replace(/[#*_`>\[\]()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return;

    // Barge-in: clear anything already queued so the new reply starts immediately.
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(clean);
    const { rate, pitch, lang, voiceName } = optsRef.current;
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.lang = lang;
    if (voiceName) {
      const match = window.speechSynthesis.getVoices().find((v) => v.name === voiceName);
      if (match) utterance.voice = match;
    }
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError(
        "This browser has no SpeechRecognition support. Use Chrome or Edge for voice input, or type instead."
      );
      return;
    }
    if (wantsListening.current) return;

    wantsListening.current = true;
    setError(null);
    setWakeWordDetected(false);

    const recognition = new Ctor();
    recognition.lang = optsRef.current.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setListening(true);

    recognition.onresult = (event) => {
      let finalText = "";
      let liveInterim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0]?.transcript ?? "";
        if (event.results[i].isFinal) finalText += chunk;
        else liveInterim += chunk;
      }

      const combined = (liveInterim || finalText).trim();
      setInterim(combined);
      optsRef.current.onInterim?.(combined);

      if (!finalText.trim()) return;

      const text = finalText.trim();
      const wake = (optsRef.current.wakeWord ?? "jarvis").toLowerCase();

      if (optsRef.current.wakeWordEnabled) {
        const lower = text.toLowerCase();
        const index = lower.indexOf(wake);
        if (index === -1) {
          // Active session but no wake word: keep listening, say nothing.
          setInterim("");
          return;
        }
        const after = text.slice(index + wake.length).replace(/^[,.\s]+/, "").trim();
        setWakeWordDetected(true);
        setInterim("");
        if (!after) return;
        optsRef.current.onFinalTranscript(after);
        return;
      }

      setInterim("");
      setWakeWordDetected(false);
      optsRef.current.onFinalTranscript(text);
    };

    recognition.onerror = (event) => {
      const map: Record<string, string> = {
        "not-allowed":
          "Microphone permission was denied. Allow microphone access for this site, then try again.",
        "service-not-allowed":
          "The browser blocked the speech service. Voice input may require a secure (https) origin.",
        no_speech: "No speech detected.",
        network: "The speech service could not be reached.",
        aborted: "",
      };
      const message = map[event.error] ?? `Voice input error: ${event.error}`;
      if (message) setError(message);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wantsListening.current = false;
        setListening(false);
        setActive(false);
      }
    };

    recognition.onend = () => {
      setListening(false);
      setInterim("");
      // Restart while voice mode remains on (browsers end sessions after silence).
      if (wantsListening.current) {
        try {
          recognition.start();
        } catch {
          wantsListening.current = false;
          setActive(false);
        }
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setActive(true);
    } catch {
      setError("Voice input could not start.");
      wantsListening.current = false;
    }
  }, []);

  const stop = useCallback(() => {
    wantsListening.current = false;
    setListening(false);
    setActive(false);
    setInterim("");
    setWakeWordDetected(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      /* already stopped */
    }
    recognitionRef.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const toggle = useCallback(() => {
    if (active) stop();
    else start();
  }, [active, start, stop]);

  // Visibility: stop recognising when the tab is hidden — a wake word cannot be honoured
  // honestly while the page is not being rendered, and it saves battery.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          /* noop */
        }
      } else if (!document.hidden && wantsListening.current && !recognitionRef.current) {
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [start]);

  useEffect(
    () => () => {
      wantsListening.current = false;
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    },
    []
  );

  const state: VoiceState = {
    supported,
    active,
    listening,
    speaking,
    interim,
    error,
    wakeWordDetected,
  };

  return { state, start, stop, toggle, speak, stopSpeaking };
}

export function availableVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices();
}
