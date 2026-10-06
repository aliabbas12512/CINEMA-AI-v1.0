import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertValidKey, type ByteRange, type ObjectStat, type StorageProvider } from "./types";

/**
 * S3-compatible storage (AWS S3, Supabase Storage S3 endpoint, Cloudflare R2,
 * MinIO). The bucket should be private; downloads use short-lived presigned URLs.
 */
export class S3Storage implements StorageProvider {
  readonly driver = "s3" as const;
  private readonly client: S3Client;

  constructor(
    private readonly opts: {
      bucket: string;
      region: string;
      endpoint?: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    },
  ) {
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: data, ContentType: contentType }));
  }

  async putFile(key: string, filePath: string, contentType: string): Promise<void> {
    assertValidKey(key);
    const { size } = await fsStat(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const s = await this.getStream(key);
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    return Buffer.concat(chunks);
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    assertValidKey(key);
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    if (!res.Body) throw new Error(`Empty body for ${key}`);
    return res.Body as Readable;
  }

  async stat(key: string): Promise<ObjectStat | null> {
    assertValidKey(key);
    try {
      const h = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return { size: Number(h.ContentLength ?? 0), contentType: h.ContentType };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await pipeline(await this.getStream(key), createWriteStream(filePath));
  }

  async signedUrl(key: string, opts: { ttlSec: number; downloadName?: string }): Promise<string | null> {
    assertValidKey(key);
    const disposition = opts.downloadName
      ? `attachment; filename="${opts.downloadName.replace(/[^A-Za-z0-9._-]/g, "_")}"`
      : undefined;
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: key, ResponseContentDisposition: disposition }),
      { expiresIn: opts.ttlSec },
    );
  }
}

export { Readable };
