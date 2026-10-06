import { buildProviderSet, summarizeProviders } from "@/server/providers/registry";
import type { BaseProvider } from "@/server/providers/types";

/**
 * CLI: show which providers are configured and validate each against its
 * real API.  Usage: npm run providers:check
 */
async function main() {
  const { providers, issues } = buildProviderSet();
  console.log("\nConfigured providers:");
  for (const row of summarizeProviders(providers, issues)) {
    console.log(`  ${row.configured ? "✓" : row.required ? "✕" : "·"} ${row.capability.padEnd(24)} ${row.configured ? `${row.provider} (${row.model})` : row.message}`);
  }
  const list: Array<[string, BaseProvider | null]> = [
    ["LLM", providers.llm],
    ["Image", providers.image],
    ["Video", providers.video.primary],
    ["Video fallback", providers.video.fallback],
    ["Voice", providers.voice.primary],
    ["Voice fallback", providers.voice.fallback],
    ["Music", providers.music],
    ["SFX", providers.sfx],
    ["Lip sync", providers.lipsync],
  ];
  console.log("\nLive validation:");
  let failed = 0;
  for (const [name, p] of list) {
    if (!p) continue;
    const r = await p.validate();
    if (!r.ok) failed++;
    console.log(`  ${r.ok ? "✓" : "✕"} ${name.padEnd(16)} ${r.message}`);
  }
  process.exit(failed ? 1 : 0);
}

void main();
