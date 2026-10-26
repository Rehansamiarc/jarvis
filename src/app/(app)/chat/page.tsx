import { Suspense } from "react";
import Chat from "@/components/Chat";
import { Spinner } from "@/components/ui";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="p-6"><Spinner label="Loading JARVIS…" /></div>}>
      <Chat />
    </Suspense>
  );
}
