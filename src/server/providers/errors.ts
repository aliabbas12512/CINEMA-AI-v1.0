/**
 * Normalized provider error. Adapters convert SDK/HTTP errors into this so the
 * retry layer can decide what to do without knowing the vendor.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;

  constructor(args: {
    provider: string;
    message: string;
    retryable: boolean;
    status?: number;
    code?: string;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "ProviderError";
    this.provider = args.provider;
    this.retryable = args.retryable;
    this.status = args.status;
    this.code = args.code;
    this.retryAfterMs = args.retryAfterMs;
  }
}

/** Thrown when a capability is requested but no provider is configured. */
export class ProviderNotConfiguredError extends Error {
  constructor(public readonly capability: string) {
    super(`${capitalize(capability)} generation provider is not configured.`);
    this.name = "ProviderNotConfiguredError";
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** HTTP statuses that indicate a transient condition. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network error / no response
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Best-effort conversion of unknown SDK errors with a `.status` field. */
export function toProviderError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown; headers?: unknown } | null;
  const statusRaw = e?.status ?? e?.statusCode;
  const status = typeof statusRaw === "number" ? statusRaw : undefined;
  let retryAfterMs: number | undefined;
  const headers = e?.headers;
  if (headers && typeof (headers as Headers).get === "function") {
    retryAfterMs = parseRetryAfter((headers as Headers).get("retry-after"));
  } else if (headers && typeof headers === "object") {
    const h = (headers as Record<string, unknown>)["retry-after"];
    retryAfterMs = parseRetryAfter(typeof h === "string" ? h : undefined);
  }
  const message = typeof e?.message === "string" && e.message ? e.message : String(err);
  return new ProviderError({
    provider,
    message: `${provider}: ${message}`.slice(0, 2000),
    retryable: isRetryableStatus(status),
    status,
    retryAfterMs,
    cause: err,
  });
}
