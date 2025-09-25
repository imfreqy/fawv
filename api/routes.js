import { Router } from "express";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";


const router = Router();
router.get("/ping", (_req, res) => res.json({ ok: true, from: "routes.js" }));
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

/* -------------------------- helpers -------------------------- */
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    (stream /** @type {Readable} */)
      .on("data", (c) => chunks.push(Buffer.from(c)))
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
      .on("error", reject);
  });
}

// Parse bucket/key from body. Prefer manifestRef (s3:// or https), else use manifestKey + VAULT_BUCKET.
function resolveLocation({ key, manifestKey, manifestRef, bucket: bodyBucket }) {
  if (manifestRef) {
    const s = String(manifestRef);
    // s3://bucket/key
    if (s.startsWith("s3://")) {
      const [, , bucket, ...rest] = s.split("/");
      return { bucket, key: rest.join("/"), hintRegion: null };
    }
    // https://<bucket>.s3.<region>.amazonaws.com/<key>
    let m = s.match(/^https?:\/\/([^.]+)\.s3\.([^.]+)\.amazonaws\.com\/(.+)$/);
    if (m) return { bucket: m[1], key: m[3], hintRegion: m[2] };
    // https://s3.<region>.amazonaws.com/<bucket>/<key>
    m = s.match(/^https?:\/\/[^/]*s3\.([^.]+)\.amazonaws\.com\/([^/]+)\/(.+)$/);
    if (m) return { bucket: m[2], key: m[3], hintRegion: m[1] };
  }

  const finalKey = key || manifestKey;
  const bucket = bodyBucket || process.env.VAULT_BUCKET;
  if (!finalKey) throw new Error("key/manifestKey or manifestRef is required");
  if (!bucket) throw new Error("bucket missing: set VAULT_BUCKET, or send { bucket } or manifestRef");
  return { bucket, key: String(finalKey), hintRegion: null };
}

// Build an S3 client for the bucket’s actual region, even if AWS_REGION is wrong.
async function getS3ForBucket(bucket, hintRegion) {
  let region = hintRegion || process.env.AWS_REGION || "us-east-1";
  let client = new S3Client({ region });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return client; // region ok
  } catch (e) {
    const hdrs = e?.$metadata?.httpHeaders || {};
    const discovered = hdrs["x-amz-bucket-region"] || e?.BucketRegion || e?.region;
    if (discovered && discovered !== region) {
      const retry = new S3Client({ region: discovered });
      // validate
      await retry.send(new HeadBucketCommand({ Bucket: bucket }));
      return retry;
    }
    throw e;
  }
}

/* --------------------------- routes -------------------------- */

// Sanity: confirm the router mounted at /api
router.get("/ping", (_req, res) => res.json({ ok: true, from: "routes.js" }));

// POST /api/verify-upload  { key | manifestKey | manifestRef, [bucket] }
router.post("/verify-upload", async (req, res) => {
  try {
    const { bucket, key, hintRegion } = (() => {
      const r = resolveLocation(req.body || {});
      return { bucket: r.bucket, key: r.key, hintRegion: r.hintRegion };
    })();

    const s3 = await getS3ForBucket(bucket, hintRegion);
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return res.json({ ok: true, exists: true, bucket, key });
    } catch {
      return res.json({ ok: true, exists: false, bucket, key });
    }
  } catch (e) {
    console.error("[verify-upload] error:", e);
    return res.status(400).json({ ok: false, error: "verify_failed", message: e?.message || String(e) });
  }
});

// POST /api/manifest/force-extra  { manifestKey|manifestRef|key, [bucket], extra: { manifestText } }
router.post("/manifest/force-extra", async (req, res) => {
  try {
    const { bucket, key, hintRegion } = (() => {
      const r = resolveLocation(req.body || {});
      return { bucket: r.bucket, key: r.key, hintRegion: r.hintRegion };
    })();
    const { extra } = req.body || {};

    const s3 = await getS3ForBucket(bucket, hintRegion);

    // Read (ok if missing)
    let obj = {};
    try {
      const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await streamToString(got.Body);
      obj = JSON.parse(body || "{}");
    } catch {
      obj = {};
    }

    // Patch
    obj.extra = obj.extra || {};
    obj.extra.manifestText = String(extra?.manifestText ?? "");

    const Body = JSON.stringify(obj, null, 2) + "\n";
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body,
      ContentType: "application/json; charset=utf-8",
    }));

    return res.json({ ok: true, bucket, key });
  } catch (e) {
    console.error("[force-extra] error:", e);
    return res.status(400).json({ ok: false, error: "force_extra_failed", message: e?.message || String(e) });
  }
});

// POST /api/hash-and-mint  — TEMP STUB so the demo finishes without chain errors
router.post("/hash-and-mint", async (req, res) => {
  try {
    const {
      s3Key, to, vaultName, product, escrowYears, visibility,
      archiveHash, endowment, manifestKeyClient,
    } = req.body || {};

    // Validate minimal inputs
    if (!s3Key || !to) {
      return res.status(400).json({ ok: false, error: "bad_request", message: "s3Key and to are required" });
    }

    // Echo back a stable fake result so UI proceeds
    const tokenId = String(Date.now());
    const tokenURI = `data:application/json;base64,${Buffer.from(JSON.stringify({
      name: `${vaultName || "Vault"} — FAWV Vault (stub)`,
      description: "Stub token while on-chain minting is disabled.",
      image: `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'><rect width='100%' height='100%' fill='black'/><text x='24' y='64' fill='white' font-family='monospace' font-size='28'>FAWV Vault (stub)</text></svg>`).toString("base64")}`,
      attributes: [
        { trait_type: "Product", value: product || "" },
        { trait_type: "Escrow Years", value: product === "Permanence+" ? escrowYears : undefined },
        { trait_type: "Visibility", value: visibility || "" },
        { trait_type: "Archive Hash (SHA-256)", value: archiveHash || "" },
        endowment ? { trait_type: "Endowment (USD)", value: endowment.usd } : undefined,
      ].filter(Boolean),
    })).toString("base64")}`;

    return res.json({
      ok: true,
      txHash: "0x" + Math.random().toString(16).slice(2).padEnd(64, "0"),
      tokenId,
      tokenURI,
      manifestKey: manifestKeyClient || null,
      manifestRef: null,
    });
  } catch (e) {
    console.error("[hash-and-mint] error:", e);
    return res.status(500).json({ ok: false, error: "hash_and_mint_failed", message: e?.message || String(e) });
  }
});

// A) /api/upload/start
router.post("/upload/start", async (req, res) => {
  try {
    const { sessionId, files } = req.body ?? {};
    if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ ok:false, error:"no_files" });
    const Bucket = process.env.S3_BUCKET; if (!Bucket) return res.status(500).json({ ok:false, error:"missing_S3_BUCKET" });

    const prefix = `demo/${sessionId || "anon"}/`;
    const items = await Promise.all(files.map(async (f, i) => {
      const relPath = f.relPath || f.name || `file-${i}-${Date.now()}`;
      const ContentType = f.contentType || "application/octet-stream";
      const Key = `${prefix}${relPath}`;
      const cmd = new PutObjectCommand({ Bucket, Key, ContentType, ServerSideEncryption: "AES256" });
      const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
      return { relPath, objectKey: Key, contentType: ContentType, sse: "AES256", uploadUrl, sha256: f.sha256 };
    }));

    res.json({ ok:true, sessionId, items });
  } catch (err) {
    console.error("upload/start error", err);
    res.status(500).json({ ok:false, error:"presign_failed" });
  }
});

// B) /api/verify-upload
router.post("/verify-upload", async (req, res) => {
  try {
    const { key } = req.body ?? {};
    if (!key) return res.status(400).json({ ok:false, error:"missing_key" });
    const Bucket = process.env.S3_BUCKET;
    const out = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    res.json({ ok:true, exists:true, size: out.ContentLength, etag: out.ETag, contentType: out.ContentType });
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404) return res.json({ ok:true, exists:false });
    console.error("verify-upload error", err);
    res.status(500).json({ ok:false, error:"verify_failed" });
  }
});

// C) /api/hash-and-mint (writes manifest.json)
router.post("/hash-and-mint", async (req, res) => {
  try {
    const { s3Key, sha256, plan, ttlYears, heartbeatMonths, metadata } = req.body ?? {};
    if (!s3Key) return res.status(400).json({ ok:false, error:"missing_s3Key" });
    const Bucket = process.env.S3_BUCKET; if (!Bucket) return res.status(500).json({ ok:false, error:"missing_S3_BUCKET" });

    const head = await s3.send(new HeadObjectCommand({ Bucket, Key: s3Key }));
    const size = head.ContentLength ?? 0;
    const contentType = head.ContentType ?? "application/octet-stream";
    const etag = (head.ETag || "").replaceAll('"','');

    const dir = s3Key.split("/").slice(0,-1).join("/");
    const manifestKey = `${dir}/manifest.json`;
    const manifest = {
      name: "FAWV Vault Manifest",
      description: "Generated by FAWV demo flow",
      version: 1,
      generated_at: new Date().toISOString(),
      source: { bucket: Bucket, object_key: s3Key, size_bytes: size, content_type: contentType, etag, sha256: sha256 || null },
      attributes: [
        { trait_type: "Plan", value: plan || "payOnceDual" },
        { trait_type: "Heirloom TTL (yrs)", value: ttlYears ?? 100 },
        { trait_type: "Heartbeat (months)", value: heartbeatMonths ?? 12 }
      ],
      extra: metadata || {}
    };

    await s3.send(new PutObjectCommand({
      Bucket, Key: manifestKey, Body: Buffer.from(JSON.stringify(manifest, null, 2)),
      ContentType: "application/json", ServerSideEncryption: "AES256"
    }));

    res.json({ ok:true, manifestKey, txHash:"0xDEMO_TX_HASH" });
  } catch (err) {
    console.error("hash-and-mint error", err);
    res.status(500).json({ ok:false, error:"hash_and_mint_failed" });
  }
});

export default router;
