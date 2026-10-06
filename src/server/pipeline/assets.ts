import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { assets, type Asset, type AssetKind } from "@/server/db/schema";
import { mimeFromExt } from "@/server/media/image-utils";
import { probe } from "@/server/media/probe";
import type { Media } from "@/server/providers/types";
import { storageKey, type StorageFolder } from "@/server/storage/types";
import type { PipelineContext } from "./context";

/**
 * Persist generated media: object storage first, then the DB row. A zero-byte
 * file is never recorded as an asset.
 */

export type SaveAssetArgs = {
  kind: AssetKind;
  folder: StorageFolder;
  /** file name without extension; must be unique per project (use entity ids). */
  name: string;
  provider?: string;
  providerModel?: string;
  providerJobId?: string;
  probeMedia?: boolean;
};

async function finish(ctx: PipelineContext, a: SaveAssetArgs, key: string, mime: string, size: number, sha: string, localPath?: string): Promise<Asset> {
  let durationSec: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  if (a.probeMedia !== false && localPath && /^(video|audio|image)\//.test(mime)) {
    const info = await probe(localPath);
    durationSec = info.durationSec || null;
    width = info.video?.width ?? null;
    height = info.video?.height ?? null;
  }
  const [row] = await ctx.db
    .insert(assets)
    .values({
      projectId: ctx.projectId,
      kind: a.kind,
      storageKey: key,
      mimeType: mime,
      byteSize: size,
      sha256: sha,
      durationSec,
      width,
      height,
      provider: a.provider ?? null,
      providerModel: a.providerModel ?? null,
      providerJobId: a.providerJobId ?? null,
    })
    .onConflictDoUpdate({
      target: assets.storageKey,
      set: { byteSize: size, sha256: sha, durationSec, width, height, mimeType: mime, provider: a.provider ?? null, providerModel: a.providerModel ?? null },
    })
    .returning();
  if (!row) throw new Error("Failed to record asset");
  return row;
}

export async function saveFileAsset(ctx: PipelineContext, filePath: string, a: SaveAssetArgs): Promise<Asset> {
  const ext = path.extname(filePath).slice(1) || "bin";
  const size = (await stat(filePath)).size;
  if (size === 0) throw new Error(`Refusing to store zero-byte file for ${a.kind}`);
  const data = await readFile(filePath);
  const sha = createHash("sha256").update(data).digest("hex");
  const key = storageKey(ctx.projectId, a.folder, `${a.name}.${ext}`);
  const mime = mimeFromExt(ext);
  await ctx.storage.putFile(key, filePath, mime);
  return finish(ctx, a, key, mime, size, sha, filePath);
}

/** Save an in-memory buffer; writes a local copy in the work dir for probing / later steps. */
export async function saveMediaAsset(ctx: PipelineContext, media: Media, a: SaveAssetArgs): Promise<{ asset: Asset; localPath: string }> {
  if (media.data.byteLength === 0) throw new Error(`Refusing to store zero-byte media for ${a.kind}`);
  const localDir = path.join(ctx.workDir, a.folder);
  await mkdir(localDir, { recursive: true });
  const localPath = path.join(localDir, `${a.name}.${media.ext}`);
  await writeFile(localPath, media.data);
  const asset = await saveFileAsset(ctx, localPath, a);
  return { asset, localPath };
}

export async function getAsset(ctx: PipelineContext, id: string): Promise<Asset> {
  const [row] = await ctx.db.select().from(assets).where(eq(assets.id, id));
  if (!row) throw new Error(`Asset ${id} not found`);
  return row;
}

/** Ensure an asset exists locally in the work dir (download from storage if needed). */
export async function assetToFile(ctx: PipelineContext, id: string): Promise<string> {
  const asset = await getAsset(ctx, id);
  const local = path.join(ctx.workDir, "cache", path.basename(asset.storageKey));
  try {
    const s = await stat(local);
    if (s.size === asset.byteSize) return local;
  } catch {
    /* not cached */
  }
  await ctx.storage.downloadToFile(asset.storageKey, local);
  return local;
}

export async function assetToMedia(ctx: PipelineContext, id: string): Promise<Media> {
  const asset = await getAsset(ctx, id);
  const data = await ctx.storage.get(asset.storageKey);
  const ext = path.extname(asset.storageKey).slice(1);
  return { data, mimeType: asset.mimeType, ext };
}
