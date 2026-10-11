import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { assertValidKey, type ByteRange, type ObjectStat, type StorageProvider } from "./types";

/**
 * Filesystem storage for development and single-node deployments. Files are
 * served only through the authenticated /api/assets route.
 */
export class LocalStorage implements StorageProvider {
  readonly driver = "local" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertValidKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("Storage path escapes root");
    return p;
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<void> {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p);
  }

  async putFile(key: string, filePath: string, _contentType: string): Promise<void> {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await copyFile(filePath, tmp);
    await rename(tmp, p);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async getStream(key: string, range?: ByteRange): Promise<Readable> {
    const p = this.resolve(key);
    return range ? createReadStream(p, { start: range.start, end: range.end }) : createReadStream(p);
  }

  async stat(key: string): Promise<ObjectStat | null> {
    try {
      const s = await stat(this.resolve(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await copyFile(this.resolve(key), filePath);
  }

  async signedUrl(): Promise<string | null> {
    return null;
  }
}
