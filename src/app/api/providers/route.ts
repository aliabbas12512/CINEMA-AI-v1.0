import { assertSameOrigin, handler, json, limit, requireUser } from "@/server/http/api";
import { buildProviderSet, summarizeProviders } from "@/server/providers/registry";
import type { BaseProvider } from "@/server/providers/types";

export const runtime = "nodejs";

/** Which providers are configured (no secrets are ever returned). */
export const GET = handler(async () => {
  await requireUser();
  const { providers, issues } = buildProviderSet();
  return json({ providers: summarizeProviders(providers, issues), issues });
});

/** Live validation against each provider's API (e.g. account reachable, Urdu voices available). */
export const POST = handler(async (req) => {
  await assertSameOrigin(req);
  const user = await requireUser();
  await limit(`validate:${user.id}`, 10, 3600);
  const { providers } = buildProviderSet();
  const list: Array<[string, BaseProvider | null]> = [
    ["Script analysis (LLM)", providers.llm],
    ["Image", providers.image],
    ["Video", providers.video.primary],
    ["Video fallback", providers.video.fallback],
    ["Voice", providers.voice.primary],
    ["Voice fallback", providers.voice.fallback],
    ["Music", providers.music],
    ["Sound effects", providers.sfx],
    ["Lip sync", providers.lipsync],
  ];
  const results = await Promise.all(
    list.map(async ([capability, p]) => {
      if (!p) return { capability, configured: false, ok: false, message: `${capability} provider is not configured.` };
      const r = await p.validate().catch((e: unknown) => ({ ok: false, message: (e as Error).message }));
      return { capability, configured: true, provider: p.info.displayName, model: p.info.model, ok: r.ok, message: r.message };
    }),
  );
  return json({ results });
});
