import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { r2Config } from "../env.js";

export function isR2Configured() {
  return r2Config !== null;
}

function requireR2() {
  if (!r2Config) {
    throw new Error(
      "Cloudflare R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and R2_PUBLIC_URL.",
    );
  }
  return r2Config;
}

let client: S3Client | undefined;

function getClient() {
  const config = requireR2();
  client ??= new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return client;
}

/** Uploads an object and returns its public CDN URL. */
export async function uploadPublicObject(key: string, body: Buffer, contentType: string) {
  const config = requireR2();
  const objectKey = key.replace(/^\/+/, "");

  await getClient().send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  );

  return `${config.publicUrl}/${objectKey}`;
}
