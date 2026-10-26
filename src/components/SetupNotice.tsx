"use client";

import { AlertTriangle, Terminal } from "lucide-react";

/**
 * Shown instead of a half-working app when required configuration is absent. Lists the
 * exact variable names so the next step is unambiguous — no guessing, no silent failure.
 */
export default function SetupNotice({
  title,
  missing,
  children,
}: {
  title: string;
  missing?: string[];
  children?: React.ReactNode;
}) {
  return (
    <div className="panel p-6 sm:p-8 w-full">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-9 w-9 place-items-center rounded-lg border border-gold/40 bg-gold/10 text-gold">
          <AlertTriangle size={18} />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-white">{title}</h1>
          <p className="mt-1 text-sm text-mute">
            Copy <code className="text-arc">.env.example</code> to{" "}
            <code className="text-arc">.env.local</code> for local development, or set these in
            Vercel → Settings → Environment Variables, then redeploy.
          </p>
        </div>
      </div>

      {missing?.length ? (
        <div className="mt-5 rounded-lg border border-line bg-void/60 p-4">
          <div className="label mb-2 flex items-center gap-2">
            <Terminal size={12} /> Missing variables
          </div>
          <ul className="space-y-1 font-mono text-[13px] text-arc">
            {missing.map((v) => (
              <li key={v}>
                <span className="text-danger">✗</span> {v}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {children}
    </div>
  );
}
