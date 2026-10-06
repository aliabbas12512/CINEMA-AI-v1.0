"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, formatDuration } from "@/lib/client-api";
import type { getProjectDetail } from "@/server/services/detail";
import type { ProjectStatus } from "@/server/services/status";
import { StatusBadge } from "./StatusBadge";

type Jsonify<T> = T extends Date ? string : T extends (infer U)[] ? Jsonify<U>[] : T extends object ? { [K in keyof T]: Jsonify<T[K]> } : T;
type Status = Jsonify<ProjectStatus>;
type Detail = Jsonify<Awaited<ReturnType<typeof getProjectDetail>>>;
type Payload = { project: { id: string; title: string; settings: Record<string, unknown> }; status: Status; detail: Detail };
type LogRow = { id: number; level: string; stage: string | null; message: string; createdAt: string };

const ACTIVE = new Set(["QUEUED", "ANALYZING", "PLANNING", "GENERATING_VOICE", "GENERATING_CHARACTERS", "GENERATING_SCENES", "GENERATING_VIDEO", "GENERATING_AUDIO", "ASSEMBLING", "QUALITY_CHECK"]);
const TABS = ["Generation", "Story", "Characters", "Scenes", "Audio", "Subtitles", "Final video", "Logs", "Costs"] as const;
type Tab = (typeof TABS)[number];

const asset = (id: string | null | undefined, download = false) => (id ? `/api/assets/${id}${download ? "?download=1" : ""}` : undefined);

export function ProjectView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<Tab>("Generation");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<Payload>(`/api/projects/${projectId}`);
      setData(d);
      setStatus(d.status);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  // Live backend state via SSE. The first event triggers the initial load; detail is
  // refreshed whenever the stage or unit counts change.
  useEffect(() => {
    const es = new EventSource(`/api/projects/${projectId}/events`);
    let lastKey = "";
    es.addEventListener("status", (ev) => {
      const s = JSON.parse((ev as MessageEvent<string>).data) as Status;
      setStatus(s);
      const key = `${s.status}|${s.stages.map((x) => `${x.completed}/${x.failed}`).join(",")}`;
      if (key !== lastKey) {
        lastKey = key;
        void load();
      }
    });
    es.onerror = () => {
      /* EventSource reconnects automatically */
    };
    return () => es.close();
  }, [projectId, load]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!data || !status) {
    return <div className="glass rounded-3xl p-10 text-white/50">{error ?? "Loading project…"}</div>;
  }
  const active = ACTIVE.has(status.status);
  const canResume = ["FAILED", "PAUSED", "CANCELLED", "DRAFT"].includes(status.status);

  return (
    <div className="space-y-6">
      <header className="glass rounded-3xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-white/40">Project</p>
            <h1 className="mt-1 font-[family-name:var(--font-display)] text-2xl text-gold-300 sm:text-3xl">{data.project.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-white/50">
              <StatusBadge status={status.status} />
              {status.control !== "none" && <span className="text-amber-200">{status.control.replace("_", " ")} — waiting for worker to confirm…</span>}
              <span>Run #{status.run}</span>
              {status.startedAt && <span>Elapsed {formatDuration(status.elapsedSec)}</span>}
              {status.etaSec !== null && active && <span>≈ {formatDuration(status.etaSec)} remaining (estimate)</span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {active && (
              <>
                <button className="btn-ghost" disabled={!!busy || status.control !== "none"} onClick={() => act("pause", () => api(`/api/projects/${projectId}/control`, { method: "POST", json: { action: "pause" } }))}>Pause</button>
                <button className="btn-danger" disabled={!!busy || status.control === "cancel_requested"} onClick={() => act("cancel", () => api(`/api/projects/${projectId}/control`, { method: "POST", json: { action: "cancel" } }))}>Cancel</button>
              </>
            )}
            {canResume && (
              <button className="btn-primary" disabled={!!busy} onClick={() => act("resume", () => api(`/api/projects/${projectId}/generate`, { method: "POST" }))}>
                {status.status === "DRAFT" ? "Generate" : "Resume / retry failed"}
              </button>
            )}
            {status.finalAssetId && (
              <a className="btn-primary" href={asset(status.finalAssetId, true)}>⬇ Download video</a>
            )}
          </div>
        </div>
        {status.error && (
          <p role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">{status.error}</p>
        )}
        {error && <p role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
        <div className="mt-5">
          <div className="flex justify-between text-xs text-white/50">
            <span>Overall progress (from backend unit state)</span>
            <span>{status.overallProgress.toFixed(1)}%</span>
          </div>
          <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-white/5">
            <div className="h-full rounded-full bg-gradient-to-r from-arcane-500 to-gold-400 transition-[width] duration-700" style={{ width: `${status.overallProgress}%` }} />
          </div>
        </div>
      </header>

      <nav className="flex gap-1 overflow-x-auto rounded-2xl border border-white/5 bg-ink-900/60 p-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm transition ${tab === t ? "bg-white/10 text-white" : "text-white/50 hover:text-white"}`}>
            {t}
          </button>
        ))}
      </nav>

      {tab === "Generation" && <GenerationTab status={status} detail={data.detail} projectId={projectId} active={active} onRetry={(shotId, kf) => act("retry", () => api(`/api/projects/${projectId}/shots/${shotId}/retry`, { method: "POST", json: { regenerateKeyframe: kf } }))} />}
      {tab === "Story" && <StoryTab detail={data.detail} />}
      {tab === "Characters" && <CharactersTab detail={data.detail} />}
      {tab === "Scenes" && <ScenesTab detail={data.detail} active={active} onRetry={(shotId, kf) => act("retry", () => api(`/api/projects/${projectId}/shots/${shotId}/retry`, { method: "POST", json: { regenerateKeyframe: kf } }))} />}
      {tab === "Audio" && <AudioTab detail={data.detail} />}
      {tab === "Subtitles" && <SubtitlesTab detail={data.detail} />}
      {tab === "Final video" && <FinalTab status={status} detail={data.detail} subtitleLanguage={String(data.project.settings.subtitleLanguage ?? "off")} />}
      {tab === "Logs" && <LogsTab projectId={projectId} />}
      {tab === "Costs" && <CostsTab status={status} detail={data.detail} />}
    </div>
  );
}

function Card({ title, children, className = "" }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`glass rounded-3xl p-6 ${className}`}>
      {title && <h2 className="mb-4 font-[family-name:var(--font-display)] text-lg text-gold-300">{title}</h2>}
      {children}
    </section>
  );
}

const STAGE_COLOR: Record<string, string> = {
  completed: "text-emerald-300",
  running: "text-arcane-400",
  failed: "text-red-300",
  paused: "text-amber-200",
  cancelled: "text-white/40",
  pending: "text-white/40",
};

function GenerationTab({ status, detail, active, onRetry }: { status: Status; detail: Detail; projectId: string; active: boolean; onRetry: (shotId: string, kf: boolean) => void }) {
  const failedShots = detail.scenes.flatMap((s) => s.shots.filter((sh) => sh.videoStatus === "failed" || sh.keyframeStatus === "failed").map((sh) => ({ ...sh, scene: s.sequence })));
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card title="Pipeline stages">
        <ul className="space-y-4">
          {status.stages.map((s) => (
            <li key={s.stage}>
              <div className="flex items-center justify-between text-sm">
                <span className="text-white">{s.label}</span>
                <span className={STAGE_COLOR[s.status]}>
                  {s.status === "running" && "● "}
                  {s.total > 1 ? `${s.completed}/${s.total}` : ""} {s.progress.toFixed(0)}%{s.failed ? ` · ${s.failed} failed` : ""}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/5">
                <div className={`h-full rounded-full transition-[width] duration-700 ${s.status === "failed" ? "bg-red-400/70" : "bg-gradient-to-r from-arcane-500 to-gold-400"}`} style={{ width: `${s.progress}%` }} />
              </div>
              {s.message && s.status === "running" && <p className="mt-1 text-xs text-white/40">{s.message}</p>}
            </li>
          ))}
        </ul>
      </Card>
      <div className="space-y-6">
        <Card title="Now">
          <dl className="space-y-2 text-sm">
            <Row k="Current stage" v={status.currentStage ? status.stages.find((s) => s.stage === status.currentStage)?.label ?? status.currentStage : "—"} />
            <Row k="Scenes animated" v={`${status.scenesCompleted} / ${status.scenesTotal}`} />
            <Row k="Current scene" v={status.currentScene ? `#${status.currentScene.sequence} ${status.currentScene.title}` : "—"} />
            <Row k="Current shot" v={status.currentShot ? `#${status.currentShot.sequence}` : "—"} />
            <Row k="Failed provider calls (retried)" v={String(status.failedProviderCalls)} />
          </dl>
        </Card>
        {status.recentErrors.length > 0 && (
          <Card title="Recent errors">
            <ul className="space-y-2 text-xs text-red-200/90">
              {status.recentErrors.map((e, i) => <li key={i}>{e.message}</li>)}
            </ul>
          </Card>
        )}
        {failedShots.length > 0 && !active && (
          <Card title="Failed shots">
            <ul className="space-y-3 text-sm">
              {failedShots.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span className="text-white/70">Scene {s.scene} · Shot {s.sequence}</span>
                  <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => onRetry(s.id, s.keyframeStatus === "failed")}>Retry</button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-white/50">{k}</dt>
      <dd className="text-right text-white">{v}</dd>
    </div>
  );
}

function StoryTab({ detail }: { detail: Detail }) {
  const story = detail.story?.story as Record<string, unknown> | undefined;
  const world = detail.story?.world as Record<string, unknown> | undefined;
  if (!story) return <Card><p className="text-white/50">The Story Bible appears after script analysis completes.</p></Card>;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title={String(story.title ?? "Story")}>
        <p className="text-sm text-gold-300/80">{String(story.genre ?? "")}</p>
        <p className="mt-3 italic text-white/80">{String(story.logline ?? "")}</p>
        <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-white/70">{String(story.plot_summary ?? "")}</p>
        <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-white/50">Timeline</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-white/70">
          {((story.timeline as Array<{ event: string }>) ?? []).map((t, i) => <li key={i}>{t.event}</li>)}
        </ol>
      </Card>
      <Card title="World Bible">
        <dl className="space-y-3 text-sm">
          {world && Object.entries(world).map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs uppercase tracking-wider text-white/40">{k.replace(/_/g, " ")}</dt>
              <dd className="text-white/80">{Array.isArray(v) ? v.join(", ") : String(v)}</dd>
            </div>
          ))}
        </dl>
        <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-white/50">Locations</h3>
        <ul className="mt-2 grid gap-3 sm:grid-cols-2">
          {detail.locations.map((l) => (
            <li key={l.id} className="overflow-hidden rounded-xl border border-white/5 bg-ink-900/60">
              {l.referenceAssetId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={asset(l.referenceAssetId)} alt={l.name} className="aspect-video w-full object-cover" />
              ) : (
                <div className="grid aspect-video place-items-center text-xs text-white/30">{l.referenceStatus}</div>
              )}
              <div className="p-3 text-sm"><p className="font-semibold text-white">{l.name}</p><p className="text-xs text-white/50">{l.type}</p></div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Original script" className="lg:col-span-2">
        <pre dir="auto" className="max-h-80 overflow-auto whitespace-pre-wrap text-sm text-white/60">{detail.script?.content}</pre>
      </Card>
    </div>
  );
}

function CharactersTab({ detail }: { detail: Detail }) {
  if (detail.characters.length === 0) return <Card><p className="text-white/50">Characters appear after script analysis.</p></Card>;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {detail.characters.map((c) => (
        <div key={c.id} className="glass overflow-hidden rounded-3xl">
          {c.referenceAssetId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={asset(c.referenceAssetId)} alt={c.name} className="aspect-[9/12] w-full object-cover object-top" />
          ) : (
            <div className="grid aspect-[9/12] place-items-center text-sm text-white/30">Reference: {c.referenceStatus}</div>
          )}
          <div className="space-y-2 p-5 text-sm">
            <div className="flex items-center justify-between"><h3 className="text-lg font-semibold text-white">{c.name}</h3><span className="text-xs text-gold-300/80">{c.role}</span></div>
            <p className="text-white/60">{c.age} · {c.gender} · {c.bodyType}</p>
            <p className="text-white/70">{c.appearance}</p>
            <p className="text-xs text-white/50"><b className="text-white/70">Wardrobe:</b> {c.clothing}</p>
            <p className="text-xs text-white/50"><b className="text-white/70">Personality:</b> {c.personality}</p>
            {c.voices.length > 0 && <p className="text-xs text-white/50"><b className="text-white/70">Voice:</b> {c.voices.map((v) => `${v.provider} ${v.voiceId}`).join(", ")}</p>}
            {c.referenceError && <p className="text-xs text-red-300">{c.referenceError}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

const UNIT_COLOR: Record<string, string> = { completed: "text-emerald-300", failed: "text-red-300", running: "text-arcane-400", unavailable: "text-amber-200/80", skipped: "text-white/30", pending: "text-white/40" };

function ScenesTab({ detail, active, onRetry }: { detail: Detail; active: boolean; onRetry: (shotId: string, kf: boolean) => void }) {
  if (detail.scenes.length === 0) return <Card><p className="text-white/50">Scenes appear after planning.</p></Card>;
  return (
    <div className="space-y-6">
      {detail.scenes.map((s) => (
        <Card key={s.id}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-wider text-white/40">Scene {s.sequence} · {s.timeOfDay} · {s.musicMood}</p>
              <h3 className="mt-1 text-lg font-semibold text-white">{s.title}</h3>
              <p className="mt-1 max-w-3xl text-sm text-white/60">{s.storyPurpose}</p>
            </div>
            <span className="text-sm text-white/50">{(s.timelineDurationSec ?? s.estimatedDurationSec).toFixed(1)}s</span>
          </div>
          {s.previewAssetId && <video className="mt-4 w-full max-w-2xl rounded-xl" src={asset(s.previewAssetId)} controls preload="metadata" />}
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-white/50">Narration & dialogue (approved)</h4>
              <ul className="mt-2 space-y-3">
                {s.lines.map((l) => (
                  <li key={l.id} className="rounded-xl bg-ink-900/60 p-3">
                    <div className="flex justify-between text-xs"><span className="text-gold-300/80">{l.kind === "narration" ? "Narrator" : l.speakerKey}</span><span className={UNIT_COLOR[l.voiceStatus]}>{l.voiceStatus}{l.audioDurationSec ? ` · ${l.audioDurationSec.toFixed(1)}s` : ""}</span></div>
                    <p className="urdu mt-1 text-right text-base text-white">{l.urduText}</p>
                    <p className="text-xs text-white/50">{l.englishText}</p>
                    {l.audioAssetId && <audio className="mt-2 h-8 w-full" src={asset(l.audioAssetId)} controls preload="none" />}
                    {l.voiceError && <p className="mt-1 text-xs text-red-300">{l.voiceError}</p>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-white/50">Shots</h4>
              <ul className="mt-2 space-y-3">
                {s.shots.map((sh) => (
                  <li key={sh.id} className="rounded-xl bg-ink-900/60 p-3 text-sm">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-white">Shot {sh.sequence} · {sh.camera.split(";")[0]} · {(sh.timelineDurationSec ?? sh.plannedDurationSec).toFixed(1)}s</span>
                      <span className="space-x-2">
                        <span className={UNIT_COLOR[sh.keyframeStatus]}>frame {sh.keyframeStatus}</span>
                        <span className={UNIT_COLOR[sh.videoStatus]}>video {sh.videoStatus}</span>
                        {sh.speakingLineId && <span className={UNIT_COLOR[sh.lipsyncStatus]}>lip-sync {sh.lipsyncStatus}</span>}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {sh.keyframeAssetId && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={asset(sh.keyframeAssetId)} alt="" className="aspect-video w-full rounded-lg object-cover" loading="lazy" />
                      )}
                      {(sh.lipsyncAssetId || sh.videoAssetId) && <video className="aspect-video w-full rounded-lg" src={asset(sh.lipsyncAssetId ?? sh.videoAssetId)} controls preload="none" />}
                    </div>
                    <p className="mt-2 text-xs text-white/50">{sh.action}</p>
                    {sh.videoProvider && <p className="mt-1 text-[11px] text-white/30">{sh.videoProvider}</p>}
                    {sh.error && <p className="mt-1 text-xs text-red-300">{sh.error}</p>}
                    {!active && (
                      <div className="mt-2 flex gap-2">
                        <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => onRetry(sh.id, false)}>Regenerate clip</button>
                        <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => onRetry(sh.id, true)}>Regenerate frame + clip</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function AudioTab({ detail }: { detail: Detail }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Final mix">
        {detail.finalMix ? (
          <>
            <audio className="w-full" src={asset(detail.finalMix.assetId)} controls preload="none" />
            <p className="mt-2 text-sm text-white/60">
              Integrated loudness {detail.finalMix.integratedLufs?.toFixed(1) ?? "?"} LUFS · true peak {detail.finalMix.truePeakDb?.toFixed(1) ?? "?"} dBTP · {detail.finalMix.durationSec.toFixed(1)}s
            </p>
          </>
        ) : (
          <p className="text-white/50">The mix is produced during assembly.</p>
        )}
      </Card>
      <Card title="Music cues">
        <ul className="space-y-3 text-sm">
          {detail.scenes.map((s) => (
            <li key={s.id}>
              <div className="flex justify-between"><span className="text-white/70">Scene {s.sequence} · {s.musicMood}</span><span className={UNIT_COLOR[s.musicStatus]}>{s.musicStatus === "unavailable" ? "provider not configured" : s.musicStatus}</span></div>
              {s.musicAssetId && <audio className="mt-1 h-8 w-full" src={asset(s.musicAssetId)} controls preload="none" />}
              {s.musicError && <p className="text-xs text-red-300">{s.musicError}</p>}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Sound effects" className="lg:col-span-2">
        <ul className="grid gap-3 text-sm sm:grid-cols-2">
          {detail.scenes.flatMap((s) => s.shots.map((sh) => (
            <li key={sh.id} className="rounded-xl bg-ink-900/60 p-3">
              <div className="flex justify-between text-xs"><span className="text-white/70">Scene {s.sequence} · Shot {sh.sequence}</span><span className={UNIT_COLOR[sh.sfxStatus]}>{sh.sfxStatus === "unavailable" ? "provider not configured" : sh.sfxStatus}</span></div>
              {sh.sfxAssetId && <audio className="mt-1 h-8 w-full" src={asset(sh.sfxAssetId)} controls preload="none" />}
            </li>
          )))}
        </ul>
      </Card>
    </div>
  );
}

function SubtitlesTab({ detail }: { detail: Detail }) {
  if (detail.subtitles.length === 0) return <Card><p className="text-white/50">Subtitles are generated from the final timed audio during assembly.</p></Card>;
  return (
    <Card title="Subtitle files (from final audio timing)">
      <ul className="grid gap-3 sm:grid-cols-2">
        {detail.subtitles.map((s) => (
          <li key={s.id} className="flex items-center justify-between rounded-xl bg-ink-900/60 p-4 text-sm">
            <span className="text-white">{s.language === "ur" ? "Urdu" : "English"} · .{s.format} · {s.cueCount} cues</span>
            <a className="btn-ghost px-3 py-1.5 text-xs" href={asset(s.assetId, true)}>Download</a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function FinalTab({ status, detail, subtitleLanguage }: { status: Status; detail: Detail; subtitleLanguage: string }) {
  const finalQc = useMemo(() => detail.qualityChecks.filter((q) => q.targetType === "final"), [detail.qualityChecks]);
  if (!status.finalAssetId) {
    return <Card><p className="text-white/50">The final video is published only after it passes automated quality control.</p></Card>;
  }
  // Browser track uses WebVTT; the MP4 also carries the selected language as a soft track.
  const sub = subtitleLanguage === "off" ? undefined : detail.subtitles.find((s) => s.format === "vtt" && s.language === subtitleLanguage);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card>
        <video className="w-full rounded-2xl" src={asset(status.finalAssetId)} poster={asset(status.thumbnailAssetId)} controls preload="metadata">
          {sub && <track kind="subtitles" src={asset(sub.assetId)} srcLang={sub.language} label={sub.language === "ur" ? "اردو" : "English"} default />}
        </video>
        <a className="btn-primary mt-4" href={asset(status.finalAssetId, true)}>⬇ Download MP4</a>
      </Card>
      <Card title="Quality control">
        <ul className="space-y-1.5 text-sm">
          {finalQc.slice(0, 20).map((q) => (
            <li key={q.id} className="flex justify-between"><span className="text-white/70">{q.check.replace(/_/g, " ")}</span><span className={q.passed ? "text-emerald-300" : q.severity === "error" ? "text-red-300" : "text-amber-200"}>{q.passed ? "pass" : q.severity}</span></li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function LogsTab({ projectId }: { projectId: string }) {
  const [logs, setLogs] = useState<LogRow[]>([]);
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const r = await api<{ logs: LogRow[] }>(`/api/projects/${projectId}/logs`);
        if (!stop) setLogs(r.logs);
      } catch {
        /* keep last */
      }
    };
    void pull();
    const t = setInterval(pull, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [projectId]);
  return (
    <Card title="Generation log">
      <ol className="max-h-[600px] space-y-1 overflow-auto font-mono text-xs">
        {logs.map((l) => (
          <li key={l.id} className={l.level === "error" ? "text-red-300" : l.level === "warn" ? "text-amber-200" : "text-white/60"}>
            <span className="text-white/30">{new Date(l.createdAt).toLocaleTimeString()}</span> {l.stage ? `[${l.stage}] ` : ""}{l.message}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function CostsTab({ status, detail }: { status: Status; detail: Detail }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Totals (recorded from provider responses)">
        {status.costs.length === 0 ? (
          <p className="text-white/50">Cost unavailable.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {status.costs.map((c) => <li key={c.unit} className="flex justify-between"><span className="text-white/70">{c.unit === "usd" ? "USD (LLM tokens)" : c.unit}</span><span className="text-white">{c.unit === "usd" ? `$${c.amount.toFixed(4)}` : c.amount.toLocaleString()}</span></li>)}
          </ul>
        )}
        <p className="mt-4 text-xs text-white/40">Providers that do not report a price (e.g. Azure Speech, ElevenLabs) are shown as “Cost unavailable”; usage (characters, seconds) is still recorded.</p>
      </Card>
      <Card title="By capability">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-white/40"><tr><th className="py-1">Capability</th><th>Jobs</th><th>Estimated</th><th>Actual</th></tr></thead>
          <tbody>
            {status.costBreakdown.map((c, i) => (
              <tr key={i} className="border-t border-white/5">
                <td className="py-1.5 text-white/80">{c.capability}</td>
                <td className="text-white/60">{c.jobs}</td>
                <td className="text-white/60">{c.unit ? `${c.estimated.toLocaleString()} ${c.unit}` : "Cost unavailable"}</td>
                <td className="text-white">{c.unit ? `${c.actual.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${c.unit}` : "Cost unavailable"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-white/40">{detail.providerJobs.length} provider requests recorded.</p>
      </Card>
    </div>
  );
}
