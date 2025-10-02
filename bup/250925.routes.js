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
  try {
    const { s3Key, sha256, plan, ttlYears, heartbeatMonths, metadata, bucket: bodyBucket } = req.body ?? {};
    if (!s3Key) return res.status(400).json({ ok:false, error:"missing_s3Key" });

    const Bucket = bodyBucket || process.env.S3_BUCKET; 
    if (!Bucket) return res.status(500).json({ ok:false, error:"missing_S3_BUCKET" });

    const s3r = await getS3ForBucket(Bucket, null);

    // Confirm object exists and grab metadata
    const head = await s3r.send(new HeadObjectCommand({ Bucket, Key: s3Key }));
    const size = head.ContentLength ?? 0;
    const contentType = head.ContentType ?? "application/octet-stream";
    const etag = (head.ETag || "").replaceAll('"','');

    // Compute sha256 if not provided
    let sha256Hex = (sha256 && String(sha256).replace(/^0x/,"")) || null;
    if (!sha256Hex) {
      const got = await s3r.send(new GetObjectCommand({ Bucket, Key: s3Key }));
      sha256Hex = await streamSha256Hex(got.Body);
    }

    const dir = s3Key.split("/").slice(0,-1).join("/");
    const manifestKey = `${dir}/manifest.json`;
    const manifest = {
      name: "FAWV Vault Manifest",
      description: "Generated by FAWV demo flow",
      version: 1,
      generated_at: new Date().toISOString(),
      source: { bucket: Bucket, object_key: s3Key, size_bytes: size, content_type: contentType, etag, sha256: sha256Hex },
      attributes: [
        { trait_type: "Plan", value: plan || "payOnceDual" },
        { trait_type: "Heirloom TTL (yrs)", value: ttlYears ?? 100 },
        { trait_type: "Heartbeat (months)", value: heartbeatMonths ?? 12 }
      ],
      extra: metadata || {}
    };

    await s3r.send(new PutObjectCommand({
      Bucket, Key: manifestKey, Body: Buffer.from(JSON.stringify(manifest, null, 2)),
      ContentType: "application/json", ServerSideEncryption: "AES256"
    }));

    // Default stub (will be overwritten on success)
    let txHash = "0xDEMO_TX_HASH";
    let tokenId = String(Date.now());
    let contractAddress = CONTRACT_ADDRESS || null;
    let chainError = null;
    let mintFnUsed = null;

    // Try on-chain mint if configured
    if (wallet && CONTRACT_ADDRESS && CONTRACT_ABI) {
      try {
        const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
        const iface = new ethers.Interface(CONTRACT_ABI);
        const bytes32Hash = "0x" + String(sha256Hex).padStart(64, "0");

        const hasFn = (name) => { try { iface.getFunction(name); return true; } catch { return false; } };

        const tokenUriJson = {
          name: "FAWV Vault",
          description: "Minted by FAWV demo",
          external_url: s3Key,
          attributes: [{ trait_type: "ArchiveSHA256", value: "0x" + sha256Hex }],
        };
        const tokenURI = `data:application/json;base64,${Buffer.from(JSON.stringify(tokenUriJson)).toString("base64")}`;

        const candidates = [
          { name: "mintVault",    args: [wallet.address, bytes32Hash, s3Key] },
          { name: "mintRecord",   args: [wallet.address, bytes32Hash, s3Key] },
          { name: "mintWithHash", args: [wallet.address, bytes32Hash, s3Key] },
          { name: "mintHash",     args: [wallet.address, bytes32Hash] },
          { name: "safeMint",     args: [wallet.address, tokenURI] },
          { name: "mintTo",       args: [wallet.address, tokenURI] },
          { name: "mint",         args: [wallet.address, tokenURI] },
        ];

        let picked = null;
        for (const c of candidates) { if (hasFn(c.name)) { picked = c; break; } }
        if (!picked) {
          chainError = "no_mint_method_in_abi";
        } else {
          mintFnUsed = picked.name;
          const tx = await contract[picked.name](...picked.args);
          const rc = await tx.wait();
          txHash = rc.hash;
          // Extract tokenId from Transfer logs if present
          try {
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
      chainError = "chain_not_configured (missing wallet or contract or abi)";
    }

    res.json({ ok:true, manifestKey, txHash, tokenId, contractAddress, chainError, mintFnUsed });
  } catch (err) {
    console.error("hash-and-mint error", err);
    const hdrs = err?.$metadata?.httpHeaders || {};
    const discovered = hdrs?.["x-amz-bucket-region"] || err?.BucketRegion || err?.region || null;
    res.status(500).json({ ok:false, error:"hash_and_mint_failed", message: err?.message || String(err), http: err?.$metadata?.httpStatusCode, discovered });
  }
});

export default router;