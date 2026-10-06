import { getEnv } from "@/server/env";
import { LocalStorage } from "./local";
import { S3Storage } from "./s3";
import type { StorageProvider } from "./types";

let instance: StorageProvider | undefined;

export function getStorage(): StorageProvider {
  if (instance) return instance;
  const env = getEnv();
  if (env.STORAGE_DRIVER === "s3") {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
    }
    instance = new S3Storage({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    });
  } else {
    instance = new LocalStorage(env.STORAGE_LOCAL_DIR);
  }
  return instance;
}

/** Test hook. */
export function setStorage(s: StorageProvider | undefined): void {
  instance = s;
}

export * from "./types";
