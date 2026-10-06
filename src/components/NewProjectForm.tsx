"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import {
  DEFAULT_SETTINGS,
  MUSIC_STYLE_LABELS,
  MUSIC_STYLES,
  VISUAL_STYLE_LABELS,
  VISUAL_STYLES,
  type ProjectSettings,
} from "@/lib/settings";

type ProviderSummary = { capability: string; configured: boolean; provider?: string; model?: string; required: boolean; message: string };

export function NewProjectForm({ maxChars }: { maxChars: number }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ providers: ProviderSummary[] }>("/api/providers")
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders([]));
  }, []);

  const set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => setSettings((s) => ({ ...s, [k]: v }));
  const missingRequired = providers?.filter((p) => p.required && !p.configured) ?? [];
  const words = script.trim() ? script.trim().split(/\s+/).length : 0;

  return (
    <form
      className="grid gap-6 lg:grid-cols-[1fr_380px]"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const { project } = await api<{ project: { id: string } }>("/api/projects", { method: "POST", json: { title: title || undefined, script, settings } });
          await api(`/api/projects/${project.id}/generate`, { method: "POST" });
          router.push(`/projects/${project.id}`);
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <section className="glass rounded-3xl p-6">
        <label className="label" htmlFor="title">Title (optional)</label>
        <input id="title" className="field mb-5" placeholder="e.g. Shehzada aur Jadui Chiragh" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        <label className="label" htmlFor="script">Story / Script — English, Urdu or Roman Urdu</label>
        <textarea
          id="script"
          required
          dir="auto"
          className="field min-h-[480px] resize-y font-mono text-[15px] leading-7"
          placeholder="Paste your complete story or screenplay here…"
          value={script}
          maxLength={maxChars}
          onChange={(e) => setScript(e.target.value)}
        />
        <div className="mt-2 flex justify-between text-xs text-white/40">
          <span>{words.toLocaleString()} words</span>
          <span>
            {script.length.toLocaleString()} / {maxChars.toLocaleString()} characters
          </span>
        </div>
      </section>

      <aside className="space-y-6">
        <section className="glass space-y-4 rounded-3xl p-6">
          <h2 className="font-[family-name:var(--font-display)] text-lg text-gold-300">Film settings</h2>
          <div>
            <label className="label" htmlFor="duration">Duration</label>
            <select id="duration" className="field" value={settings.targetDurationSec} onChange={(e) => set("targetDurationSec", Number(e.target.value))}>
              {[60, 120, 180, 300, 480, 600, 900].map((s) => (
                <option key={s} value={s}>{s / 60} minute{s === 60 ? "" : "s"}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="style">Visual style</label>
            <select id="style" className="field" value={settings.visualStyle} onChange={(e) => set("visualStyle", e.target.value as ProjectSettings["visualStyle"])}>
              {VISUAL_STYLES.map((s) => <option key={s} value={s}>{VISUAL_STYLE_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Voice language</label>
              <div className="field opacity-80">Urdu</div>
            </div>
            <div>
              <label className="label">Accent</label>
              <div className="field opacity-80">Pakistani</div>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="narrator">Narrator voice</label>
            <select id="narrator" className="field" value={settings.narratorVoice} onChange={(e) => set("narratorVoice", e.target.value as ProjectSettings["narratorVoice"])}>
              <option value="male">Male narrator</option>
              <option value="female">Female narrator</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="subs">Subtitles</label>
              <select id="subs" className="field" value={settings.subtitleLanguage} onChange={(e) => set("subtitleLanguage", e.target.value as ProjectSettings["subtitleLanguage"])}>
                <option value="off">Off</option>
                <option value="ur">Urdu</option>
                <option value="en">English</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="burn">Burn-in</label>
              <select id="burn" className="field" disabled={settings.subtitleLanguage === "off"} value={settings.burnSubtitles ? "yes" : "no"} onChange={(e) => set("burnSubtitles", e.target.value === "yes")}>
                <option value="no">Soft track</option>
                <option value="yes">Burned in</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor="res">Resolution</label>
              <select id="res" className="field" value={settings.resolution} onChange={(e) => set("resolution", e.target.value as ProjectSettings["resolution"])}>
                <option value="1080p">1080p</option>
                <option value="2160p">4K*</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ar">Aspect</label>
              <select id="ar" className="field" value={settings.aspectRatio} onChange={(e) => set("aspectRatio", e.target.value as ProjectSettings["aspectRatio"])}>
                <option value="16:9">16:9</option>
                <option value="9:16">9:16</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="fps">FPS</label>
              <select id="fps" className="field" value={settings.fps} onChange={(e) => set("fps", Number(e.target.value) as 24 | 30)}>
                <option value={24}>24</option>
                <option value={30}>30</option>
              </select>
            </div>
          </div>
          {settings.resolution === "2160p" && (
            <p className="text-xs text-amber-200/80">* 4K is upscaled by FFmpeg from the provider&apos;s native clip resolution; it is labelled as such.</p>
          )}
          <div>
            <label className="label" htmlFor="music">Music style</label>
            <select id="music" className="field" value={settings.musicStyle} onChange={(e) => set("musicStyle", e.target.value as ProjectSettings["musicStyle"])}>
              {MUSIC_STYLES.map((m) => <option key={m} value={m}>{MUSIC_STYLE_LABELS[m]}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-3 text-sm text-white/80">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-gold-400)]" checked={settings.lipSync} onChange={(e) => set("lipSync", e.target.checked)} />
            Lip-sync speaking characters (when provider supports it)
          </label>
        </section>

        <section className="glass rounded-3xl p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/60">Provider readiness</h2>
          {providers === null ? (
            <p className="text-sm text-white/40">Checking configuration…</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {providers.map((p) => (
                <li key={p.capability} className="flex items-start justify-between gap-3">
                  <span className="text-white/70">{p.capability}{!p.required && <span className="text-white/30"> (optional)</span>}</span>
                  <span className={p.configured ? "text-emerald-300" : p.required ? "text-red-300" : "text-amber-200/80"}>
                    {p.configured ? `${p.provider}` : "Not configured"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {missingRequired.length > 0 && (
            <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs text-amber-100">
              {missingRequired.map((p) => p.message).join(" ")} Generation will run every stage it can and stop with a clear message at the first missing provider.
            </p>
          )}
        </section>

        {error && <p role="alert" className="rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
        <button type="submit" className="btn-primary w-full py-3.5 text-base" disabled={busy || script.trim().length < 200}>
          {busy ? "Starting…" : "✦ Generate Video"}
        </button>
        {script.trim().length > 0 && script.trim().length < 200 && <p className="text-center text-xs text-white/40">Scripts need at least 200 characters.</p>}
      </aside>
    </form>
  );
}
