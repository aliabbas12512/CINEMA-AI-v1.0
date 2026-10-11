"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";

type Summary = { capability: string; configured: boolean; provider?: string; model?: string; fallback?: string; required: boolean; message: string };
type Validation = { capability: string; configured: boolean; provider?: string; model?: string; ok: boolean; message: string };

export function ProviderPanel() {
  const [summary, setSummary] = useState<Summary[] | null>(null);
  const [results, setResults] = useState<Validation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ providers: Summary[] }>("/api/providers").then((r) => setSummary(r.providers)).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <div className="glass overflow-hidden rounded-3xl">
        <table className="w-full text-left text-sm">
          <thead className="bg-white/5 text-xs uppercase tracking-wider text-white/50">
            <tr><th className="px-5 py-3">Capability</th><th className="px-5 py-3">Provider</th><th className="px-5 py-3">Model</th><th className="px-5 py-3">Fallback</th><th className="px-5 py-3">Status</th></tr>
          </thead>
          <tbody>
            {(summary ?? []).map((p) => (
              <tr key={p.capability} className="border-t border-white/5">
                <td className="px-5 py-3 text-white">{p.capability}{!p.required && <span className="text-white/30"> · optional</span>}</td>
                <td className="px-5 py-3 text-white/70">{p.provider ?? "—"}</td>
                <td className="px-5 py-3 font-mono text-xs text-white/60">{p.model ?? "—"}</td>
                <td className="px-5 py-3 text-white/60">{p.fallback ?? "—"}</td>
                <td className={`px-5 py-3 ${p.configured ? "text-emerald-300" : p.required ? "text-red-300" : "text-amber-200/80"}`}>{p.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        className="btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setResults((await api<{ results: Validation[] }>("/api/providers", { method: "POST" })).results);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Validating with providers…" : "Validate live connections"}
      </button>
      {error && <p className="text-sm text-red-300">{error}</p>}
      {results && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {results.map((r) => (
            <li key={r.capability} className="glass rounded-2xl p-4">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">{r.capability}</span>
                <span className={r.ok ? "text-emerald-300" : r.configured ? "text-red-300" : "text-white/40"}>{r.ok ? "✓ OK" : r.configured ? "✕ Failed" : "Not configured"}</span>
              </div>
              <p className="mt-1 text-sm text-white/60">{r.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
