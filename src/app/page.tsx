import Link from "next/link";
import { requirePageUser } from "@/server/auth/page-auth";
import { getDb } from "@/server/db/client";
import { listProjects } from "@/server/services/projects";
import { StatusBadge } from "@/components/StatusBadge";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const user = await requirePageUser();
  const projects = await listProjects(getDb(), user.id);

  return (
    <div className="space-y-10">
      <section className="glass relative overflow-hidden rounded-3xl p-8 sm:p-12">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-arcane-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 left-1/3 h-72 w-72 rounded-full bg-gold-500/10 blur-3xl" />
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-gold-400">Script → Cinematic Film</p>
        <h1 className="mt-3 max-w-3xl font-[family-name:var(--font-display)] text-3xl leading-tight text-white sm:text-5xl">
          Turn one story into a ten-minute fantasy film with a Pakistani Urdu voice cast.
        </h1>
        <p className="mt-4 max-w-2xl text-white/60">
          Paste your script in English, Urdu or Roman Urdu. The studio writes the story bible, designs consistent characters and worlds,
          plans every shot, voices narration and dialogue, scores the film and renders it — with real progress at every step.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/projects/new" className="btn-primary px-6 py-3 text-base">✦ Create New Video</Link>
          <Link href="/settings/providers" className="btn-ghost px-6 py-3 text-base">Check providers</Link>
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-end justify-between">
          <h2 className="font-[family-name:var(--font-display)] text-xl text-gold-300">Your projects</h2>
          <span className="text-sm text-white/40">{projects.length} total</span>
        </div>
        {projects.length === 0 ? (
          <div className="glass rounded-2xl p-10 text-center text-white/50">No projects yet. Your first film starts with a story.</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="glass group overflow-hidden rounded-2xl transition hover:border-gold-400/30">
                <div className="aspect-video bg-ink-800">
                  {p.thumbnailAssetId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/assets/${p.thumbnailAssetId}`} alt="" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
                  ) : (
                    <div className="grid h-full place-items-center text-4xl text-white/10">✦</div>
                  )}
                </div>
                <div className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="line-clamp-2 font-semibold text-white">{p.title}</h3>
                    <StatusBadge status={p.status} />
                  </div>
                  <p className="text-xs text-white/40">{new Date(p.createdAt).toLocaleString()}</p>
                  {p.error && <p className="line-clamp-2 text-xs text-red-300/80">{p.error}</p>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
