/**
 * manifest-force-extra.ts (TypeScript, ESM)
 * Forces a merge of `extra` (including `manifestText`) into an existing manifest.json on S3.
 */
import type { Request, Response } from "express";
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

const DEFAULT_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const DEFAULT_BUCKET = process.env.S3_BUCKET;
const SSE = process.env.S3_SSE; // e.g., "AES256"

function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

function coerceKey(any: unknown): string | null {
  if (!any) return null;
  const s = String(any);
  if (s.startsWith("s3://")) {
    const without = s.replace(/^s3:\/\//, "");
    const parts = without.split("/");
    parts.shift(); // drop bucket
    return decodeURIComponent(parts.join("/"));
  }
  let m = s.match(/^https?:\/\/([^.]+)\.s3\.([^.]+)\.amazonaws\.com\/(.+)$/);
  if (m) return decodeURIComponent(m[3]);
  m = s.match(/^https?:\/\/[^/]*s3\.([^.]+)\.amazonaws\.com\/([^/]+)\/(.+)$/);
  if (m) return decodeURIComponent(m[3]);
  try { return decodeURIComponent(s.replace(/^\/+/, "")); } catch { return s.replace(/^\/+/, ""); }
}

function resolveLocation(body: any, query: any): { bucket: string, key: string, hintRegion: string | null } {
  const { manifestRef } = body || {};
  if (manifestRef) {
    const s = String(manifestRef);
    if (s.startsWith("s3://")) {
      const [, , bucket, ...rest] = s.split("/");
      return { bucket, key: coerceKey(rest.join("/"))!, hintRegion: null };
    }
    let m = s.match(/^https?:\/\/([^.]+)\.s3\.([^.]+)\.amazonaws\.com\/(.+)$/);
    if (m) return { bucket: m[1], key: coerceKey(m[3])!, hintRegion: m[2] };
    m = s.match(/^https?:\/\/[^/]*s3\.([^.]+)\.amazonaws\.com\/([^/]+)\/(.+)$/);
    if (m) return { bucket: m[2], key: coerceKey(m[3])!, hintRegion: m[1] };
  }
  const key = coerceKey(body?.manifestKey || body?.key || body?.ref || query?.key);
  const bucket = body?.bucket || DEFAULT_BUCKET;
  if (!key) throw new Error("missing_key");
  if (!bucket) throw new Error("missing_bucket");
  return { bucket, key, hintRegion: null };
}

async function getS3ForBucket(bucket: string, hintRegion: string | null): Promise<S3Client> {
  let region = hintRegion || DEFAULT_REGION;
  let c = new S3Client({ region });
  try {
    await c.send(new HeadBucketCommand({ Bucket: bucket }));
    return c;
  } catch (e: any) {
    const hdrs = e?.$metadata?.httpHeaders || {};
    const discovered = hdrs["x-amz-bucket-region"] || e?.BucketRegion || e?.region;
    if (discovered && discovered !== region) {
      const retry = new S3Client({ region: discovered });
      await retry.send(new HeadBucketCommand({ Bucket: bucket }));
      return retry;
    }
    throw e;
  }
}

function deepMerge<T extends Record<string, any>>(a: T | undefined, b: T | undefined): T {
  const isObj = (v: any) => v && typeof v === "object" && !Array.isArray(v);
  const out: any = isObj(a) ? { ...a } : {};
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export async function forceExtra(req: Request, res: Response) {
  try {
    const { bucket, key, hintRegion } = resolveLocation(req.body || {}, req.query || {});
    const s3 = await getS3ForBucket(bucket, hintRegion);

    console.log("[force-extra] incoming", {
      bucket,
      key,
      hasExtra: !!(req.body?.extra),
      hasManifestText: typeof req.body?.manifestText === "string",
    });

    // Ensure manifest exists (404 if not)
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (e: any) {
      const msg = e?.name || e?.message || "NoSuchKey";
      return res.status(404).json({ ok: false, error: "manifest_not_found", message: msg, bucket, key });
    }

    // Load -> merge -> save
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const raw = await streamToString(got.Body as any as Readable);
    const obj = (raw ? JSON.parse(raw) : {}) as Record<string, any>;

    const extra = (req.body?.extra && typeof req.body.extra === "object") ? req.body.extra : {};
    const manifestText = typeof req.body?.manifestText === "string" ? req.body.manifestText : undefined;

    obj.extra = deepMerge(obj.extra, extra);
    if (typeof manifestText === "string") {
      obj.extra = obj.extra || {};
      obj.extra.manifestText = manifestText;
    }
    obj.updatedAt = new Date().toISOString();

    const putParams: any = {
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(JSON.stringify(obj, null, 2) + "\n"),
      ContentType: "application/json; charset=utf-8",
    };
    if (SSE) putParams.ServerSideEncryption = SSE;

    const put = await s3.send(new PutObjectCommand(putParams));

    return res.json({
      ok: true,
      bucket,
      key,
      etag: put.ETag,
      sse: put.ServerSideEncryption || SSE || null,
      updatedAt: obj.updatedAt,
    });
  } catch (err: any) {
    console.error("[force-extra] error:", err);
    return res.status(400).json({ ok: false, error: "force_extra_failed", message: err?.message || String(err) });
  }
}
