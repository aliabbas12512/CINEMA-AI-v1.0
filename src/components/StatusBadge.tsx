const STYLES: Record<string, string> = {
  COMPLETED: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  FAILED: "bg-red-500/15 text-red-300 border-red-400/30",
  CANCELLED: "bg-white/5 text-white/50 border-white/10",
  PAUSED: "bg-amber-500/15 text-amber-200 border-amber-400/30",
  DRAFT: "bg-white/5 text-white/60 border-white/10",
};

export function StatusBadge({ status }: { status: string }) {
  const style = STYLES[status] ?? "bg-arcane-500/15 text-arcane-400 border-arcane-400/30";
  const running = !STYLES[status];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${style}`}>
      {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-arcane-400" />}
      {status.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}
