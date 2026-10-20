import { isR2Configured, uploadPublicObject } from "../src/lib/r2.js";

// 1×1 transparent PNG. Used only to prove the R2 bucket and public URL work.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

if (!isR2Configured()) {
  console.error(
    "R2 is not configured. Create a Cloudflare R2 bucket, then set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and R2_PUBLIC_URL in .env.",
  );
  process.exit(1);
}

const url = await uploadPublicObject("phase1/health-pixel.png", PIXEL_PNG, "image/png");
console.log(url);
