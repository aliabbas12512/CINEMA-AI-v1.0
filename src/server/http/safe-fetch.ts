import { lookup } from "node:dns/promises";
import net from "node:net";
import { ProviderError } from "@/server/providers/errors";

/**
 * SSRF-hardened downloader for provider output URLs.
 *
 * Provider task results contain URLs we did not construct. Before fetching we
 * require https, resolve DNS and reject private / loopback / link-local /
 * metadata addresses, refuse redirects to such hosts, and cap the size.
 */

const MAX_REDIRECTS = 3;

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number) as [number, number, number, number];
    const [a, b] = p;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
    if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true;
    if (v.startsWith("ff")) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "https:") throw new Error(`Refusing non-https URL: ${url.protocol}`);
  if (url.username || url.password) throw new Error("Refusing URL with credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error("Host did not resolve");
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error(`Refusing to fetch private address for host ${host}`);
  }
  return url;
}

export async function downloadToBuffer(
  provider: string,
  rawUrl: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ data: Buffer; contentType: string | null }> {
  const maxBytes = opts.maxBytes ?? 1024 * 1024 * 1024;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let url: URL;
    try {
      url = await assertPublicHttpsUrl(current);
    } catch (err) {
      throw new ProviderError({ provider, message: `Unsafe output URL: ${(err as Error).message}`, retryable: false });
    }
    let res: Response;
    try {
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 10 * 60_000) });
    } catch (err) {
      throw new ProviderError({ provider, message: `Download failed: ${(err as Error).message}`, retryable: true, cause: err });
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new ProviderError({ provider, message: "Redirect without location", retryable: false });
      current = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok || !res.body) {
      throw new ProviderError({
        provider,
        message: `Download failed with HTTP ${res.status}`,
        retryable: res.status >= 500 || res.status === 429,
        status: res.status,
      });
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new ProviderError({ provider, message: "Output exceeds size limit", retryable: false });
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProviderError({ provider, message: "Output exceeds size limit", retryable: false });
      }
      chunks.push(Buffer.from(value));
    }
    return { data: Buffer.concat(chunks), contentType: res.headers.get("content-type") };
  }
  throw new ProviderError({ provider, message: "Too many redirects", retryable: false });
}
