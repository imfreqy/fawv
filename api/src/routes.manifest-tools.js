// routes.manifest-tools.js — standalone router to set manifest.contentHash from server-side SHA-256
import express from "express";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

const router = express.Router();
router.use(express.json());

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const S3_BUCKET  = process.env.S3_BUCKET || process.env.VAULT_BUCKET || "";

if (!S3_BUCKET) {
  console.warn("[manifest-tools] WARNING: S3_BUCKET/VAULT_BUCKET is not set");
}

const s3 = new S3Client({ region: AWS_REGION });

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

async function sha256HexOfKey(Key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key }));
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise((resolve, reject) => {
    r.Body.on("data", (c) => { bytes += c.length; hash.update(c); });
    r.Body.on("end", resolve);
    r.Body.on("error", reject);
  });
  return { sha256Hex: hash.digest("hex"), bytes };
}

async function listUnderPrefix(Prefix) {
  const out = [];
  let ContinuationToken;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix, ContinuationToken }));
    (res.Contents || []).forEach(o => out.push({ key: o.Key, size: o.Size, lastModified: o.LastModified?.toISOString?.() }));
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}

// POST /manifest/set-content-hash
// body: { manifestKey?: string, prefix?: string, payloadKey?: string, setAssetSha256?: boolean }
router.post("/manifest/set-content-hash", async (req, res) => {
  try {
    if (!S3_BUCKET) return res.status(500).json({ ok:false, error:"missing_S3_BUCKET" });
    const { manifestKey: mkIn, prefix: pfxIn, payloadKey: pkIn, setAssetSha256 } = req.body || {};
    const prefix = pfxIn || (mkIn ? mkIn.replace(/\/manifest\.json$/i, "/") : null);
    const manifestKey = mkIn || (prefix ? `${prefix}manifest.json` : null);
    if (!manifestKey) return res.status(400).json({ ok:false, error:"bad_request", message:"manifestKey or prefix required" });

    let payloadKey = pkIn;
    if (!payloadKey) {
      // choose the largest non-JSON file under prefix
      if (!prefix) return res.status(400).json({ ok:false, error:"bad_request", message:"prefix required when payloadKey is missing" });
      const objs = await listUnderPrefix(prefix);
      const candidates = objs.filter(o => !/\.json$/i.test(o.key));
      if (candidates.length === 0) return res.status(400).json({ ok:false, error:"no_payload_found" });
      candidates.sort((a,b) => (b.size||0) - (a.size||0));
      payloadKey = candidates[0].key;
    }

    const { sha256Hex, bytes } = await sha256HexOfKey(payloadKey);

    // load manifest
    const got = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: manifestKey }));
    let manifest = {};
    try {
      manifest = JSON.parse(await streamToString(got.Body) || "{}");
    } catch (e) {
      return res.status(400).json({ ok:false, error:"manifest_parse_error", message: e?.message || String(e) });
    }

    // write contentHash (and optional asset.sha256)
    manifest.contentHash = sha256Hex;
    if (setAssetSha256) {
      manifest.asset = manifest.asset || {};
      manifest.asset.sha256 = sha256Hex;
    }

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: manifestKey,
      Body: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf-8"),
      ContentType: "application/json; charset=utf-8",
      ServerSideEncryption: "AES256",
    }));

    res.json({ ok:true, manifestKey, payloadKey, sha256Hex, bytes });
  } catch (err) {
    console.error("[manifest/set-content-hash] error", err);
    res.status(500).json({ ok:false, error:"set_content_hash_failed", message: err?.message || "UnknownError" });
  }
});

export default router;