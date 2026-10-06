import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { assets, projects } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { handler, HttpError, requireUser } from "@/server/http/api";
import { getStorage } from "@/server/storage";

export const runtime = "nodejs";

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] ? Number(m[1]) : NaN;
  let end = m[2] ? Number(m[2]) : NaN;
  if (Number.isNaN(start)) {
    if (Number.isNaN(end)) return null;
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end) || end >= size) end = size - 1;
  if (start > end || start >= size) return null;
  return { start, end };
}

/**
 * Authenticated media delivery. Only the project owner can read an asset.
 * S3 storage -> short-lived presigned redirect; local storage -> streamed
 * here with HTTP Range support (video seeking).
 */
export const GET = handler(async (req, { params }: { params: Promise<{ assetId: string }> }) => {
  const user = await requireUser();
  const { assetId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new HttpError(404, "Not found");
  const [row] = await getDb()
    .select({ asset: assets, ownerId: projects.userId, title: projects.title })
    .from(assets)
    .innerJoin(projects, eq(projects.id, assets.projectId))
    .where(eq(assets.id, assetId));
  if (!row || row.ownerId !== user.id) throw new HttpError(404, "Not found");
  const { asset } = row;
  const download = new URL(req.url).searchParams.get("download") === "1";
  const ext = asset.storageKey.split(".").pop() ?? "bin";
  const fileName = `${row.title.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 60) || "video"}-${asset.kind}.${ext}`;
  const storage = getStorage();

  const signed = await storage.signedUrl(asset.storageKey, { ttlSec: getEnv().SIGNED_URL_TTL_SEC, downloadName: download ? fileName : undefined });
  if (signed) return Response.redirect(signed, 302);

  const size = asset.byteSize;
  const range = parseRange(req.headers.get("range"), size);
  const headers: Record<string, string> = {
    "Content-Type": asset.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${fileName}"`,
  };
  if (req.headers.get("range") && !range) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const nodeStream = await storage.getStream(asset.storageKey, range ?? undefined);
  const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    return new Response(body, { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(body, { status: 200, headers });
});
