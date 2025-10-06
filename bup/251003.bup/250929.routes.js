import 'dotenv/config';
import { Router } from "express";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const router = Router();

// ---- Chain wiring ----
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || null;

// ---- ABI loader via fs (works without import assertions) ----
const ABI_PATH = path.resolve(__dirname, "./src/abi/FAWVMinter721.json");
let CONTRACT_ABI = null;
try {
  const json = JSON.parse(fs.readFileSync(ABI_PATH, "utf-8"));
  CONTRACT_ABI = json?.abi ?? null;
  console.log("[ABI] Loaded:", ABI_PATH);
} catch (e) {
  console.warn("[ABI] Could not read:", ABI_PATH, e?.message || e);
}

// ---- S3 helpers ----
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    (stream /** @type {Readable} */)
      .on("data", (c) => chunks.push(Buffer.from(c)))
      .on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
      .on("error", reject);
  });
}
async function streamSha256Hex(stream) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    (stream /** @type {Readable} */)
      .on("data", (c) => hash.update(c))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

// Parse bucket/key from body. Prefer manifestRef (s3:// or https), else use manifestKey + S3_BUCKET/VAULT_BUCKET.
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
  const bucket = bodyBucket || process.env.VAULT_BUCKET || process.env.S3_BUCKET;
  if (!finalKey) throw new Error("key/manifestKey or manifestRef is required");
  if (!bucket) throw new Error("bucket missing: set S3_BUCKET/VAULT_BUCKET, or send { bucket } or manifestRef");
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
      await retry.send(new HeadBucketCommand({ Bucket: bucket }));
      return retry;
    }
    throw e;
  }
}

// Writes JSON to S3. Private by default (works with Bucket owner enforced).
async function putPublicJsonToS3(bucket, key, obj, hintRegion = null) {
  const s3 = await getS3ForBucket(bucket, hintRegion);
  const Body = Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf-8");
  const wantACL = String(process.env.PUBLIC_JSON_ACL || "").toLowerCase() === "true";
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body,
    ContentType: "application/json; charset=utf-8",
    ...(wantACL ? { ACL: "public-read" } : {}),
  }));
  return { url: `https://${bucket}.s3.amazonaws.com/${key}`, public: wantACL };
}


/* --------------------------- debug routes -------------------------- */

router.get("/debug/provider", async (_req, res) => {
  try {
    const net = await provider.getNetwork();
    const blockNumber = await provider.getBlockNumber();
    res.json({
      url: process.env.SEPOLIA_RPC_URL || "unset",
      chainId: Number(net.chainId),
      blockNumber,
      hasSigner: !!wallet,
      contractConfigured: !!(CONTRACT_ADDRESS && CONTRACT_ABI),
      contractAddress: CONTRACT_ADDRESS || null,
      abiPath: CONTRACT_ABI ? ABI_PATH : null
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.get("/debug/s3", async (req, res) => {
  const bucket = req.query.bucket || process.env.S3_BUCKET || process.env.VAULT_BUCKET;
  if (!bucket) return res.status(400).json({ ok:false, error:"missing_bucket" });
  let discovered = null;
  try {
    let s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    discovered = process.env.AWS_REGION || "us-east-1";
    return res.json({ ok:true, bucket, region: discovered });
  } catch (e) {
    const hdrs = e?.$metadata?.httpHeaders || {};
    discovered = hdrs["x-amz-bucket-region"] || e?.BucketRegion || e?.region || null;
    if (discovered) {
      try {
        let s3b = new S3Client({ region: discovered });
        await s3b.send(new HeadBucketCommand({ Bucket: bucket }));
        return res.json({ ok:true, bucket, region: discovered });
      } catch (e2) {
        return res.status(500).json({ ok:false, error:"head_bucket_failed", message:String(e2), discovered });
      }
    } else {
      return res.status(500).json({ ok:false, error:"head_bucket_unknown", message:String(e) });
    }
  }
});

/* --------------------------- main routes -------------------------- */

// POST /api/verify-upload  { key | manifestKey | manifestRef, [bucket] }
router.post("/verify-upload", async (req, res) => {
  try {
    const { bucket, key, hintRegion } = (() => {
      const r = resolveLocation(req.body || {});
      return { bucket: r.bucket, key: r.key, hintRegion: r.hintRegion };
    })();

    try {
      const s3 = await getS3ForBucket(bucket, hintRegion);
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return res.json({ ok: true, exists: true, bucket, key });
    } catch (e) {
      const hdrs = e?.$metadata?.httpHeaders || {};
      const discovered = hdrs["x-amz-bucket-region"] || e?.BucketRegion || e?.region || null;
      console.error("[verify-upload] headObject error:", { bucket, key, discovered, code: e?.name, http: e?.$metadata?.httpStatusCode, msg: e?.message });
      return res.status(200).json({ ok: true, exists: false, bucket, key, discovered, http: e?.$metadata?.httpStatusCode, code: e?.name });
    }
  } catch (e) {
    console.error("[verify-upload] fatal:", e);
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

// A) /api/upload/start
router.post("/upload/start", async (req, res) => {
  try {
    const { sessionId, files, bucket: bodyBucket } = req.body ?? {};
    if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ ok:false, error:"no_files" });
    const Bucket = bodyBucket || process.env.S3_BUCKET; if (!Bucket) return res.status(500).json({ ok:false, error:"missing_S3_BUCKET" });

    const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
    const prefix = `demo/${sessionId || "anon"}/`;
    const items = await Promise.all(files.map(async (f, i) => {
      const relPath = f.relPath || f.name || `file-${i}-${Date.now()}`;
      const ContentType = f.contentType || "application/octet-stream";
      const Key = `${prefix}${relPath}`;
      const cmd = new PutObjectCommand({ Bucket, Key, ContentType, ServerSideEncryption: "AES256" });
      const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
      return { relPath, objectKey: Key, contentType: ContentType, sse: "AES256", uploadUrl, sha256: f.sha256 };
    }));

    res.json({ ok:true, sessionId, items, bucket: Bucket });
  } catch (err) {
    console.error("upload/start error", err);
    res.status(500).json({ ok:false, error:"presign_failed", message: err?.message || String(err) });
  }
});

// C) /api/hash-and-mint (writes manifest.json + optional on-chain mint with graceful fallback)

router.post("/hash-and-mint", async (req, res) => {
  console.log("[hash-and-mint] begin");
  try {
    const {
      sessionId,
      manifestKeyClient,        // e.g. "demo/<sessionId>/manifest.json"
      publicMetadata = {},      // { name, description, image, external_url, attributes[] }
      minterAddress: minterAddressIn,
      to,
      s3Key, sha256,
      bucket: bodyBucket
    } = req.body ?? {};

    const Bucket = bodyBucket || process.env.S3_BUCKET || process.env.VAULT_BUCKET;
    const minterAddress = minterAddressIn || to || null;

    if (!Bucket) return res.status(500).json({ ok:false, error:"missing_S3_BUCKET" });
    if (!manifestKeyClient || !sessionId) {
      return res.status(400).json({ ok:false, error:"bad_request", message:"sessionId and manifestKeyClient are required" });
    }

    // 1) Read existing client-written manifest
    const s3c = await getS3ForBucket(Bucket, null);
    let manifest = {};
    try {
      const got = await s3c.send(new GetObjectCommand({ Bucket, Key: manifestKeyClient }));
      const body = await streamToString(got.Body);
      manifest = JSON.parse(body || "{}");
    } catch (e) {
      return res.status(400).json({ ok:false, error:"manifest_missing", message:`Could not read ${manifestKeyClient}: ${String(e?.message || e)}` });
    }

    // 2) Build token-metadata.json used for tokenURI
    const tokenMeta = {
      name: publicMetadata.name || `FAWV Vault — ${manifest?.name || sessionId}`,
      description: publicMetadata.description || "Vaulted asset",
      image: publicMetadata.image || null,
      external_url: publicMetadata.external_url || null,
      attributes: Array.isArray(publicMetadata.attributes) ? publicMetadata.attributes : [],
      vault_manifest_ref: `s3://${Bucket}/${manifestKeyClient}`
    };

    // 3) Publish token-metadata.json next to manifest.json
    const baseDir = manifestKeyClient.replace(/[^/]+$/, "");
    const tokenMetaKey = `${baseDir}token-metadata.json`;
    let tokenURI;
    try {
      const { url } = await putPublicJsonToS3(Bucket, tokenMetaKey, tokenMeta, null);
      tokenURI = url;
      console.log("[hash-and-mint] token-metadata written", { Bucket, tokenMetaKey });
    } catch (e) {
      const base64 = Buffer.from(JSON.stringify(tokenMeta)).toString("base64");
      tokenURI = `data:application/json;base64,${base64}`;
      console.warn("[hash-and-mint] fell back to data: URI", e?.message || e);
    }

    // 4) Optional sha256 for hash-based contracts
    let sha256Hex = (sha256 && String(sha256).replace(/^0x/,"")) || null;
    const contentKey = s3Key
      || manifest?.source?.object_key
      || (Array.isArray(manifest?.files) && manifest.files[0]?.key);
    if (!sha256Hex && contentKey) {
      try {
        const got = await s3c.send(new GetObjectCommand({ Bucket, Key: contentKey }));
        sha256Hex = await streamSha256Hex(got.Body);
      } catch {}
    }
    const bytes32Hash = sha256Hex ? ("0x" + String(sha256Hex).padStart(64, "0")) : null;

    // 5) Mint (non-blocking: do NOT await confirmations)
    let txHash = null;
    let tokenId = null;
    let contractAddress = CONTRACT_ADDRESS || null;
    let chainError = null;
    let mintFnUsed = null;

    if (wallet && CONTRACT_ADDRESS && CONTRACT_ABI && minterAddress) {
      try {
        const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
        const iface = new ethers.Interface(CONTRACT_ABI);
        const hasFn = (name) => { try { iface.getFunction(name); return true; } catch { return false; } };

        const candidates = [
          tokenURI ? { name: "safeMint",     args: [minterAddress, tokenURI] } : null,
          tokenURI ? { name: "mintTo",       args: [minterAddress, tokenURI] } : null,
          tokenURI ? { name: "mint",         args: [minterAddress, tokenURI] } : null,
          (bytes32Hash && contentKey) ? { name: "mintVault",    args: [minterAddress, bytes32Hash, contentKey] } : null,
          (bytes32Hash && contentKey) ? { name: "mintRecord",   args: [minterAddress, bytes32Hash, contentKey] } : null,
          (bytes32Hash && contentKey) ? { name: "mintWithHash", args: [minterAddress, bytes32Hash, contentKey] } : null,
          bytes32Hash ? { name: "mintHash",  args: [minterAddress, bytes32Hash] } : null
        ].filter(Boolean);

        let picked = null;
        for (const c of candidates) { if (hasFn(c.name)) { picked = c; break; } }
        if (!picked) {
          chainError = "no_supported_mint_method_in_abi";
        } else {
          mintFnUsed = picked.name;
          const tx = await contract[picked.name](...picked.args);
          txHash = tx.hash; // DO NOT await confirmations to avoid blocking
          // optional: don't block, but try to get token id if Transfer appears quickly
          try {
            const rc = await tx.wait(0); // returns immediately on some chains/providers
            for (const log of rc.logs) {
              try {
                const parsed = iface.parseLog(log);
                if (parsed?.name === "Transfer") {
                  tokenId = (parsed.args?.tokenId ?? parsed.args?.[2])?.toString?.() || tokenId;
                  break;
                }
              } catch {}
            }
          } catch {}
          contractAddress = contract.target ?? CONTRACT_ADDRESS;
        }
      } catch (e) {
        console.error("[mint] error:", e);
        chainError = String(e?.reason || e?.message || e);
      }
    } else {
      chainError = chainError || "mint_skipped_missing_config_or_address";
    }

    // 6) Merge token block back into manifest.json (always include tokenURI)
    try {
      const got = await s3c.send(new GetObjectCommand({ Bucket, Key: manifestKeyClient }));
      const body = await streamToString(got.Body);
      manifest = JSON.parse(body || "{}");
    } catch {}

    manifest.token = {
      ...(manifest.token || {}),
      contractAddress: contractAddress || null,
      tokenId: tokenId ? String(tokenId) : null,
      tokenURI,
      txHash,
      mintedAt: tokenId ? new Date().toISOString() : undefined,
      minterAddress: minterAddress || undefined
    };

    await s3c.send(new PutObjectCommand({
      Bucket,
      Key: manifestKeyClient,
      Body: Buffer.from(JSON.stringify(manifest, null, 2) + "\\n", "utf-8"),
      ContentType: "application/json; charset=utf-8",
      ServerSideEncryption: "AES256"
    }));

    console.log("[hash-and-mint] done", { sessionId, manifestKeyClient, tokenMetaKey, wroteMeta: !!tokenURI });
    return res.json({
      ok: true,
      manifestKey: manifestKeyClient,
      manifestRef: `s3://${Bucket}/${manifestKeyClient}`,
      tokenMetaKey,
      tokenURI,
      tokenId,
      contractAddress,
      txHash,
      chainError,
      mintFnUsed
    });
  } catch (err) {
    console.error("hash-and-mint error", err);
    return res.status(500).json({ ok:false, error:"hash_and_mint_failed", message: err?.message || String(err) });
  }
});


export default router;