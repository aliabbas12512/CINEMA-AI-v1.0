"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client-api";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto mt-10 max-w-md">
      <div className="glass rounded-3xl p-8 shadow-2xl shadow-black/40">
        <h1 className="font-[family-name:var(--font-display)] text-2xl text-gold-300">
          {mode === "login" ? "Welcome back" : "Create your studio"}
        </h1>
        <p className="mt-1 text-sm text-white/50">
          {mode === "login" ? "Sign in to continue your films." : "One story. One cinematic Urdu film."}
        </p>
        <form
          className="mt-6 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api(`/api/auth/${mode}`, { method: "POST", json: mode === "signup" ? { email, password, name } : { email, password } });
              router.push("/");
              router.refresh();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {mode === "signup" && (
            <div>
              <label className="label" htmlFor="name">Name</label>
              <input id="name" className="field" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </div>
          )}
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" type="email" required className="field" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              minLength={mode === "signup" ? 10 : 1}
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>
          {error && <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</p>}
          <button className="btn-primary w-full" disabled={busy} type="submit">
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-white/50">
          {mode === "login" ? (
            <>No account? <Link className="text-gold-300 hover:underline" href="/signup">Create one</Link></>
          ) : (
            <>Already have an account? <Link className="text-gold-300 hover:underline" href="/login">Sign in</Link></>
          )}
        </p>
      </div>
    </div>
  );
}
