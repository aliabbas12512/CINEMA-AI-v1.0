import { ProviderPanel } from "@/components/ProviderPanel";
import { requirePageUser } from "@/server/auth/page-auth";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  await requirePageUser();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-gold-300">AI providers</h1>
        <p className="mt-1 max-w-3xl text-white/50">
          Providers are configured on the server with environment variables (see ENVIRONMENT.md). Keys never reach the browser.
          &ldquo;Validate&rdquo; calls each provider&apos;s real API to confirm the account, model and Urdu voices are available.
        </p>
      </div>
      <ProviderPanel />
    </div>
  );
}
