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

// Try to read a mint price from common view functions.
// Returns a BigInt (wei) or 0n if not found.
async function detectMintPrice(contract) {
  const priceABIs = [
    "function mintPrice() view returns (uint256)",
    "function price() view returns (uint256)",
    "function MINT_PRICE() view returns (uint256)",
    "function PRICE() view returns (uint256)",
    "function cost() view returns (uint256)",
    "function publicPrice() view returns (uint256)",
    "function mintCost() view returns (uint256)"
  ];
  for (const sig of priceABIs) {
    try {
      const tmp = new ethers.Contract(contract.target, [sig], contract.runner);
      const fn = sig.match(/function\s+([^(]+)/)[1];
      const v = await tmp[fn]();
      const bi = BigInt(v.toString());
      if (bi >= 0n) return bi;
    } catch {
      // ignore and try next
    }
  }
  return 0n;
}

// v6-safe picker that also tests with overrides (e.g., payable value)
async function pickMintCallWithOverrides(contract, { to, tokenURI, bytes32Hash, contentKey, overrides }) {
  // Try more permissive names and put `mint` before `safeMint` (some contracts gate safeMint).
  const candidates = [
    tokenURI ? { name: "mint",         args: [to, tokenURI] } : null,
    tokenURI ? { name: "mintTo",       args: [to, tokenURI] } : null,
    tokenURI ? { name: "safeMint",     args: [to, tokenURI] } : null,
    tokenURI ? { name: "mintNFT",      args: [to, tokenURI] } : null,
    tokenURI ? { name: "mintItem",     args: [to, tokenURI] } : null,
    tokenURI ? { name: "awardItem",    args: [to, tokenURI] } : null,
    tokenURI ? { name: "mintURI",      args: [to, tokenURI] } : null,
    tokenURI ? { name: "mintWithURI",  args: [to, tokenURI] } : null,
    (bytes32Hash && contentKey) ? { name: "mintVault",    args: [to, bytes32Hash, contentKey] } : null,
    (bytes32Hash && contentKey) ? { name: "mintRecord",   args: [to, bytes32Hash, contentKey] } : null,
    (bytes32Hash && contentKey) ? { name: "mintWithHash", args: [to, bytes32Hash, contentKey] } : null,
    bytes32Hash ? { name: "mintHash",  args: [to, bytes32Hash] } : null
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      const method = contract.getFunction(c.name);
      // v6: test populate/estimate with overrides
      await method.populateTransaction(...c.args, overrides || {});
      // Some nodes still revert only on estimate; try an explicit estimate too:
      try { await contract.estimateGas[c.name](...c.args, overrides || {}); } catch { /* ignore */ }
      return c;
    } catch (e) {
      console.log("[mint] skip", c.name, "-", e?.code || e?.message || e);
    }
  }
  return null;
}


const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const router = Router();

// ---- Chain wiring ----
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || null;
// ---- Global config (module scope) ----
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const S3_BUCKET  = process.env.S3_BUCKET || process.env.VAULT_BUCKET; // <- define ONCE here
// optional toggles you might be using elsewhere:
const MINT_DISABLED = String(process.env.MINT_DISABLED || '').toLowerCase() === 'true';


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
// Force verify to use your env bucket and nothing else.
router.post("/verify-upload", async (req, res) => {
  try {
    const { key } = req.body ?? {};
    if (!key) return res.status(400).json({ ok:false, error:"missing_key" });

    const Bucket = process.env.S3_BUCKET; // <— do not trust req.body.bucket
    if (!Bucket) return res.status(500).json({ ok:false, error:"missing_S3_BUCKET" });

    // If you have a region-aware helper, use it; otherwise use your default S3 client.
    const s3c = (typeof getS3ForBucket === "function")
      ? await getS3ForBucket(Bucket)
      : new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

    try {
      await s3c.send(new HeadObjectCommand({ Bucket, Key: key }));
      console.log("[verify-upload] exists", { Bucket, Key: key });
      return res.json({ ok:true, exists:true, bucket: Bucket, key });
    } catch (e) {
      console.warn("[verify-upload] not found (yet)", {
        Bucket, Key: key,
        code: e?.$metadata?.httpStatusCode, name: e?.name, msg: e?.message
      });
      return res.json({ ok:true, exists:false, bucket: Bucket, key });
    }
  } catch (err) {
    console.error("verify-upload error", err);
    return res.status(500).json({ ok:false, error:"verify_failed", message: err?.message || String(err) });
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

// /api/hash-and-mint (writes manifest.json + optional on-chain mint with graceful fallback)

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

    const Bucket = S3_BUCKET;
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
let contractAddress = process.env.CONTRACT_ADDRESS || null;
let chainError = null;
let mintFnUsed = null;

const RPC_URL = process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const rpcConfigured = Boolean(RPC_URL && PRIVATE_KEY && contractAddress && minterAddress);

if (!MINT_DISABLED && rpcConfigured) {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
    const code     = await provider.getCode(contractAddress);

    if (!code || code === "0x") {
      chainError = "no_contract_code_at_CONTRACT_ADDRESS";
    } else {
      // --- diagnostics (keep) ---
      let diag = { from: null, owner: null, hasMinter: null, paused: null };
      try { diag.from = await wallet.getAddress(); } catch (e) {}
      try {
        const ownable = new ethers.Contract(contractAddress, ["function owner() view returns (address)"], wallet);
        diag.owner = await ownable.owner();
      } catch (e) {}
      try {
        const access = new ethers.Contract(contractAddress, ["function hasRole(bytes32,address) view returns (bool)"], wallet);
        const MINTER_ROLE = ethers.id("MINTER_ROLE");
        diag.hasMinter = await access.hasRole(MINTER_ROLE, diag.from);
      } catch (e) {}
      try {
        const pausable = new ethers.Contract(contractAddress, ["function paused() view returns (bool)"], wallet);
        diag.paused = await pausable.paused();
      } catch (e) {}
      console.log("[mint] diag", diag);

      // --- Interface probes (ERC-165): are we ERC721, ERC721Metadata, or ERC1155?
try {
  const ifaceProbe = new ethers.Contract(
    contractAddress,
    ["function supportsInterface(bytes4) view returns (bool)"],
    wallet
  );
  const IID_ERC165         = "0x01ffc9a7";
  const IID_ERC721         = "0x80ac58cd";
  const IID_ERC721Metadata = "0x5b5e139f";
  const IID_ERC1155        = "0xd9b67a26";
  const supports = {};
  try { supports.ERC165  = await ifaceProbe.supportsInterface(IID_ERC165); } catch {}
  try { supports.ERC721  = await ifaceProbe.supportsInterface(IID_ERC721); } catch {}
  try { supports.Meta721 = await ifaceProbe.supportsInterface(IID_ERC721Metadata); } catch {}
  try { supports.ERC1155 = await ifaceProbe.supportsInterface(IID_ERC1155); } catch {}
  console.log("[mint][supportsInterface]", supports);
} catch {}


      // --- OPTIONAL: one-time baseURI setter if contract requires baseURI and you're owner ---
      try {
        const base = tokenURI ? tokenURI.replace(/token-metadata\.json$/,"") : null;
        if (base) {
          const setters = [
            "function setBaseURI(string)",
            "function setBaseTokenURI(string)",
            "function setURI(string)"
          ];
          for (const sig of setters) {
            try {
              const name = sig.match(/function\s+([^(]+)/)[1];
              const cfg  = new ethers.Contract(contractAddress, [sig], wallet);
              // static check; if reverts we skip quietly
              await cfg.getFunction(name).staticCall(base);
              const txSet = await cfg.getFunction(name)(base);
              console.log("[mint] baseURI set via", name, "tx:", txSet.hash);
              break;
            } catch (e) { /* try next setter */ }
          }
        }
      } catch (e) {}

      // --- detect payable mint price (if any) and set overrides ---
      let priceWei = 0n;
      try {
        const priceSigs = [
          "function mintPrice() view returns (uint256)",
          "function price() view returns (uint256)",
          "function MINT_PRICE() view returns (uint256)",
          "function PRICE() view returns (uint256)",
          "function cost() view returns (uint256)",
          "function publicPrice() view returns (uint256)",
          "function mintCost() view returns (uint256)",
        ];
        for (const sig of priceSigs) {
          try {
            const name  = sig.match(/function\s+([^(]+)/)?.[1];
            if (!name) continue;
            const probe = new ethers.Contract(contractAddress, [sig], wallet);
            const v     = await probe[name]();
            const bi    = BigInt(v.toString());
            if (bi >= 0n) { priceWei = bi; break; }
          } catch (e) {}
        }
      } catch (e) {}
      const overrides = {};
      if (priceWei > 0n) {
        overrides.value = priceWei;
        console.log("[mint] price detected (wei):", priceWei.toString());
      }

// --- OPTIONAL ADMIN NUDGES (owner-only): try to enable minting if the contract uses sale gates ---
// We'll attempt a small set of common admin functions. Each:
//   1) staticCall to see if signature exists & would succeed, then
//   2) send the tx if staticCall passes.
try {
  // --- signature-based candidates (ethers v6; avoids ambiguity) ---
// Try common owner/public/URI/hash variants, then 721A-style (quantity), then 1155-style.
const candidates = [
  // ERC-721 owner/public
  ["safeMint(address)",                   [minterAddress]],
  ["mint(address)",                       [minterAddress]],
  ["mintTo(address)",                     [minterAddress]],
  ["publicMint(uint256)",                 [1]],
  ["mintPublic(uint256)",                 [1]],
  ["mintAllowlist(uint256)",              [1]],

  // ERC-721 with tokenURI
  tokenURI ? ["mint(address,string)",        [minterAddress, tokenURI]] : null,
  tokenURI ? ["mintTo(address,string)",      [minterAddress, tokenURI]] : null,
  tokenURI ? ["safeMint(address,string)",    [minterAddress, tokenURI]] : null,
  tokenURI ? ["mintNFT(address,string)",     [minterAddress, tokenURI]] : null,
  tokenURI ? ["mintItem(address,string)",    [minterAddress, tokenURI]] : null,
  tokenURI ? ["awardItem(address,string)",   [minterAddress, tokenURI]] : null,
  tokenURI ? ["mintURI(address,string)",     [minterAddress, tokenURI]] : null,
  tokenURI ? ["mintWithURI(address,string)", [minterAddress, tokenURI]] : null,

  // ERC-721 hash-based
  (bytes32Hash && contentKey) ? ["mintVault(address,bytes32,string)",    [minterAddress, bytes32Hash, contentKey]] : null,
  (bytes32Hash && contentKey) ? ["mintRecord(address,bytes32,string)",   [minterAddress, bytes32Hash, contentKey]] : null,
  (bytes32Hash && contentKey) ? ["mintWithHash(address,bytes32,string)", [minterAddress, bytes32Hash, contentKey]] : null,
  bytes32Hash ? ["mintHash(address,bytes32)",  [minterAddress, bytes32Hash]] : null,

  // ERC-721A / custom quantity-based owner mints
  ["safeMint(address,uint256)",           [minterAddress, 1]],
  ["mint(address,uint256)",               [minterAddress, 1]],
  ["mintTo(address,uint256)",             [minterAddress, 1]],
  ["ownerMint(address,uint256)",          [minterAddress, 1]],
  ["adminMint(address,uint256)",          [minterAddress, 1]],
  ["teamMint(address,uint256)",           [minterAddress, 1]],
  ["devMint(address,uint256)",            [minterAddress, 1]],
  ["reserveMint(address,uint256)",        [minterAddress, 1]],
  ["airdrop(address,uint256)",            [minterAddress, 1]],
  ["airdrop(address[])",                  [[minterAddress]]],

  // ERC-1155 patterns (if the contract is 1155)
  // Note: id=1, amount=1, data="0x"
  ["mint(address,uint256,uint256,bytes)", [minterAddress, 1, 1, "0x"]],
  ["mintTo(address,uint256,uint256,bytes)", [minterAddress, 1, 1, "0x"]],
  ["mint(address,uint256,uint256)",       [minterAddress, 1, 1]],
  ["mintPublic(address,uint256,uint256)", [minterAddress, 1, 1]],
].filter(Boolean);


  for (const [sig, args] of adminCandidates) {
    try {
      const name = sig.match(/([^(]+)/)[1];
      const admin = new ethers.Contract(contractAddress, [ `function ${sig}` ], wallet);

      // shape probe (will throw if arg mismatch)
      await admin.getFunction(name).populateTransaction(...args);

      // try static first; if it reverts, skip quietly
      try {
        await admin.getFunction(name).staticCall(...args);
      } catch { continue; }

      // send it; don't block the flow on waiting
      const txAdmin = await admin.getFunction(name)(...args);
      console.log("[mint][admin]", sig, "tx:", txAdmin.hash);
      // optional: await provider.waitForTransaction(txAdmin.hash, 0, 12_000);
      break; // we managed to fire one admin switch; move on to mint attempts
    } catch {
      // signature missing or wrong args; try next
    }
  }
} catch {}


      // --- signature-based candidates (ethers v6; avoids ambiguity) ---
      const candidates = [
        ["safeMint(address)",                   [minterAddress]],
        ["mint(address)",                       [minterAddress]],
        ["mintTo(address)",                     [minterAddress]],
        ["publicMint(uint256)",                 [1]],
        ["mintPublic(uint256)",                 [1]],
        ["mintAllowlist(uint256)",              [1]],
        tokenURI   ? ["mint(address,string)",        [minterAddress, tokenURI]] : null,
        tokenURI   ? ["mintTo(address,string)",      [minterAddress, tokenURI]] : null,
        tokenURI   ? ["safeMint(address,string)",    [minterAddress, tokenURI]] : null,
        tokenURI   ? ["mintNFT(address,string)",     [minterAddress, tokenURI]] : null,
        tokenURI   ? ["mintItem(address,string)",    [minterAddress, tokenURI]] : null,
        tokenURI   ? ["awardItem(address,string)",   [minterAddress, tokenURI]] : null,
        tokenURI   ? ["mintURI(address,string)",     [minterAddress, tokenURI]] : null,
        tokenURI   ? ["mintWithURI(address,string)", [minterAddress, tokenURI]] : null,
        (bytes32Hash && contentKey) ? ["mintVault(address,bytes32,string)",    [minterAddress, bytes32Hash, contentKey]] : null,
        (bytes32Hash && contentKey) ? ["mintRecord(address,bytes32,string)",   [minterAddress, bytes32Hash, contentKey]] : null,
        (bytes32Hash && contentKey) ? ["mintWithHash(address,bytes32,string)", [minterAddress, bytes32Hash, contentKey]] : null,
        bytes32Hash ? ["mintHash(address,bytes32)",  [minterAddress, bytes32Hash]] : null,
      ].filter(Boolean);

      const IFACE_TRANSFER = new ethers.Interface([
        "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
      ]);

      let tx = null;
      mintFnUsed = null;

      // Try each signature: populate → staticCall (to catch reverts) → send
      for (const [sig, args] of candidates) {
        try {
          const c = new ethers.Contract(
            contractAddress,
            [ `function ${sig}`, "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)" ],
            wallet
          );

          // shape check
          await c.getFunction(sig).populateTransaction(...args, overrides);

          // static call first; if it reverts, try next signature
          try {
            await c.getFunction(sig).staticCall(...args, overrides);
          } catch (staticErr) {
            console.log("[mint] static revert", sig, "-", staticErr?.shortMessage || staticErr?.reason || staticErr?.code || String(staticErr));
            continue;
          }

          console.log("[mint] using", sig);

          // send
          const sent = await c.getFunction(sig)(...args, overrides);
          tx = sent;
          txHash = sent.hash;          // set immediately so client can poll /tx-status
          mintFnUsed = sig;
          console.log("[mint] tx", sent.hash);

          // best-effort: parse tokenId from Transfer log
          try {
            const rc = await provider.waitForTransaction(sent.hash, 0, 12_000);
            if (rc) {
              for (const log of rc.logs || []) {
                try {
                  const parsed = IFACE_TRANSFER.parseLog(log);
                  if (parsed?.name === "Transfer") {
                    tokenId = (parsed.args?.tokenId ?? parsed.args?.[2])?.toString?.() || tokenId;
                    break;
                  }
                } catch (e) {}
              }
            }
          } catch (e) {}
          break; // success
        } catch (e) {
          console.log("[mint] skip", sig, "-", e?.shortMessage || e?.reason || e?.code || String(e));
        }
      }

      if (!tx) {
        chainError = chainError || "no_supported_mint_method_on_contract_or_reverted";
      }
    }
  } catch (e) {
    chainError = String(e?.reason || e?.message || e);
    console.error("[mint] setup error:", chainError);
  }
} else if (!rpcConfigured) {
  chainError = "mint_skipped (missing RPC/PK/contract/address)";
} else {
  chainError = "mint_skipped (disabled)";
}





 // 6) Persist token info into manifest.json and return tx details
let chainId = null;
try {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  chainId = Number(net.chainId);
} catch {}

manifest.token = {
  ...(manifest.token || {}),
  chainId: chainId ?? manifest.token?.chainId,
  contractAddress: contractAddress || null,
  tokenURI,
  txHash,                                   // ✅ make sure this is included
  tokenId: tokenId ? String(tokenId) : null,
  mintedAt: tokenId ? new Date().toISOString() : manifest.token?.mintedAt,
  minterAddress: minterAddress || manifest.token?.minterAddress
};

// write manifest back to S3
await s3c.send(new PutObjectCommand({
  Bucket,
  Key: manifestKeyClient,
  Body: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf-8"),
  ContentType: "application/json; charset=utf-8",
  ServerSideEncryption: "AES256"
}));

console.log("[hash-and-mint] done", {
  sessionId,
  manifestKeyClient,
  tokenMetaKey,
  wroteMeta: !!tokenURI,
  txHash,
  tokenId,
  chainError

  
});

// Respond with txHash so the client can poll if tokenId isn't ready yet
return res.json({
  ok: true,
  sessionId,
  manifestKeyClient,
  tokenMetaKey,
  tokenURI,
  tokenId: tokenId ? String(tokenId) : null,
  txHash,                      // ✅ client uses this for /api/tx-status
  contractAddress,
  chainError,
  mintFnUsed
});



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


// ─────────────────────────────────────────────────────────────
// Sepolia / Alchemy minting (isolated from upload flow)
// Env expected: SEPOLIA_RPC_URL (or RPC_URL), PRIVATE_KEY, CONTRACT_ADDRESS
// ─────────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || "";
const DEFAULT_CONTRACT = process.env.CONTRACT_ADDRESS || "";

function getWallet() {
  if (!RPC_URL || !PRIVATE_KEY) return null;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  return new ethers.Wallet(PRIVATE_KEY, provider);
}

// More permissive ABI: includes common URI-based and hash-based mint names,
// plus the Transfer event so you can parse tokenId from the receipt.
// Broad ABI: common URI + hash styles and the Transfer event
// Broad ABI: URI + hash flavors + Transfer event
const MINT_ABI = [
  // URI-based
  "function safeMint(address to, string tokenURI) returns (uint256)",
  "function mintTo(address to, string tokenURI) returns (uint256)",
  "function mint(address to, string tokenURI) returns (uint256)",
  "function mintNFT(address to, string tokenURI) returns (uint256)",
  "function mintItem(address to, string tokenURI) returns (uint256)",
  "function awardItem(address to, string tokenURI) returns (uint256)",
  "function mintURI(address to, string tokenURI) returns (uint256)",
  "function mintWithURI(address to, string tokenURI) returns (uint256)",
  // hash-based
  "function mintVault(address to, bytes32 contentHash, string key) returns (uint256)",
  "function mintRecord(address to, bytes32 contentHash, string key) returns (uint256)",
  "function mintWithHash(address to, bytes32 contentHash, string key) returns (uint256)",
  "function mintHash(address to, bytes32 contentHash) returns (uint256)",
  // event
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
];

// v6: probe with getFunction(...).populateTransaction(...)
async function pickMintCall(contract, { to, tokenURI, bytes32Hash, contentKey }) {
  const candidates = [
    tokenURI ? { name: "safeMint",     args: [to, tokenURI] } : null,
    tokenURI ? { name: "mintTo",       args: [to, tokenURI] } : null,
    tokenURI ? { name: "mint",         args: [to, tokenURI] } : null,
    tokenURI ? { name: "mintNFT",      args: [to, tokenURI] } : null,
    tokenURI ? { name: "mintItem",     args: [to, tokenURI] } : null,
    tokenURI ? { name: "awardItem",    args: [to, tokenURI] } : null,
    tokenURI ? { name: "mintURI",      args: [to, tokenURI] } : null,
    tokenURI ? { name: "mintWithURI",  args: [to, tokenURI] } : null,
    (bytes32Hash && contentKey) ? { name: "mintVault",    args: [to, bytes32Hash, contentKey] } : null,
    (bytes32Hash && contentKey) ? { name: "mintRecord",   args: [to, bytes32Hash, contentKey] } : null,
    (bytes32Hash && contentKey) ? { name: "mintWithHash", args: [to, bytes32Hash, contentKey] } : null,
    bytes32Hash ? { name: "mintHash",  args: [to, bytes32Hash] } : null
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      const method = contract.getFunction(c.name);
      await method.populateTransaction(...c.args); // v6 way
      console.log("[mint] using", c.name);
      return c;
    } catch (e) {
      console.log("[mint] skip", c.name, "-", e?.code || e?.message || e);
    }
  }
  return null;
}




// 1) Chain health: sanity check your RPC + contract
router.get("/chain/health", async (req, res) => {
  try {
    const wallet = getWallet();
    if (!wallet) return res.status(500).json({ ok:false, error:"missing_rpc_or_pk" });
    const provider = wallet.provider;
    const net = await provider.getNetwork();

    const contractAddr = DEFAULT_CONTRACT || String(req.query.contract || "");
    if (!contractAddr) return res.status(400).json({ ok:false, error:"missing_contract_address" });

    // presence check
    const code = await provider.getCode(contractAddr);
    const contractOk = code && code !== "0x";
    return res.json({
      ok: true,
      chainId: Number(net.chainId),
      contractAddress: contractAddr,
      contractOk
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error:"chain_health_failed", message: err?.message || String(err) });
  }
});

// 2) Mint only (non-blocking). Call this AFTER your upload/manifest/metadata steps.
router.post("/mint/token", async (req, res) => {
  try {
    const {
      to,                   // minter address
      tokenURI,             // usually the S3 URL to token-metadata.json
      bytes32Hash,          // optional "0x..." sha256
      contentKey,           // optional s3 key (if your contract expects it)
      contractAddress       // overrides DEFAULT_CONTRACT if provided
    } = req.body ?? {};

    const wallet = getWallet();
    if (!wallet) return res.status(500).json({ ok:false, error:"missing_rpc_or_pk" });

    if (!to)       return res.status(400).json({ ok:false, error:"missing_to" });
    if (!tokenURI && !bytes32Hash) return res.status(400).json({ ok:false, error:"need_tokenURI_or_bytes32Hash" });

    const address = contractAddress || DEFAULT_CONTRACT;
    if (!address)  return res.status(400).json({ ok:false, error:"missing_contract_address" });

    const contract = new ethers.Contract(address, MINT_ABI, wallet);
    const iface = new ethers.Interface(MINT_ABI);

    const call = pickMintCall(iface, { to, tokenURI, bytes32Hash, contentKey });
    if (!call) return res.status(400).json({ ok:false, error:"no_supported_mint_method_in_abi" });

    const tx = await contract[call.name](...call.args);
    let tokenId = null;

    // Best-effort: try to get tokenId quickly without blocking the UI
    try {
      const rc = await wallet.provider.waitForTransaction(tx.hash, 0, 12000);
      if (rc) {
        for (const log of rc.logs || []) {
          try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === "Transfer") {
              tokenId = (parsed.args?.tokenId ?? parsed.args?.[2])?.toString?.() || tokenId;
              break;
            }
          } catch {}
        }
      }
    } catch { /* quick receipt may time out - fine */ }

    return res.json({
      ok: true,
      contractAddress: address,
      txHash: tx.hash,
      tokenId: tokenId ? String(tokenId) : null,
      method: call.name
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error:"mint_failed", message: err?.reason || err?.message || String(err) });
  }
});

// 3) (Optional) tx status polling – omit if you already added one earlier
router.get("/tx-status", async (req, res) => {
  try {
    const tx = String(req.query?.tx || "");
    if (!tx) return res.status(400).json({ ok:false, error:"missing_tx" });
    const wallet = getWallet();
    if (!wallet) return res.status(500).json({ ok:false, error:"missing_rpc_or_pk" });

    const receipt = await wallet.provider.getTransactionReceipt(tx);
    if (!receipt) return res.json({ ok:true, status:"pending", tokenId: null, confirmations: 0 });

    const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
    let tokenId = null;
    for (const log of receipt.logs || []) {
      if (log.topics && log.topics[0] === TRANSFER_TOPIC && log.topics.length >= 4) {
        try { tokenId = ethers.toBigInt(log.topics[3]).toString(); break; } catch {}
      }
    }
    let confirmations = 0;
    try {
      const tip = await wallet.provider.getBlockNumber();
      confirmations = receipt.blockNumber ? (tip - Number(receipt.blockNumber) + 1) : 0;
    } catch {}

    return res.json({
      ok: true,
      status: receipt.status === 1 ? "confirmed" : "reverted",
      tokenId,
      txHash: receipt.transactionHash,
      contractAddress: receipt.to,
      blockNumber: receipt.blockNumber,
      confirmations
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error:"tx_status_failed", message: err?.message || String(err) });
  }
});

router.post("/mint/token", async (req, res) => {
  try {
    const {
      to,                   // destination wallet
      tokenURI,             // S3 URL to token-metadata.json
      bytes32Hash,          // optional "0x..." sha256
      contentKey,           // optional s3 key (if your contract expects it)
      contractAddress       // optional override; falls back to env CONTRACT_ADDRESS
    } = req.body ?? {};

    const wallet = getWallet(); // uses your RPC + PRIVATE_KEY
    if (!wallet) return res.status(500).json({ ok:false, error:"missing_rpc_or_pk" });

    if (!to) return res.status(400).json({ ok:false, error:"missing_to" });
    if (!tokenURI && !bytes32Hash) {
      return res.status(400).json({ ok:false, error:"need_tokenURI_or_bytes32Hash" });
    }

    const address = contractAddress || DEFAULT_CONTRACT;
    if (!address) return res.status(400).json({ ok:false, error:"missing_contract_address" });

    const contract = new ethers.Contract(address, MINT_ABI, wallet);
    const iface = new ethers.Interface(MINT_ABI);

    const call = pickMintCall(iface, { to, tokenURI, bytes32Hash, contentKey });
    if (!call) return res.status(400).json({ ok:false, error:"no_supported_mint_method_in_abi" });

    const tx = await contract[call.name](...call.args);
    let tokenId = null;

    // Best-effort: try to get tokenId quickly without blocking the UI
    try {
      const rc = await wallet.provider.waitForTransaction(tx.hash, 0, 12000);
      if (rc) {
        for (const log of rc.logs || []) {
          try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === "Transfer") {
              tokenId = (parsed.args?.tokenId ?? parsed.args?.[2])?.toString?.() || tokenId;
              break;
            }
          } catch {}
        }
      }
    } catch { /* quick receipt may time out - that’s fine */ }

    return res.json({
      ok: true,
      contractAddress: address,
      txHash: tx.hash,
      tokenId: tokenId ? String(tokenId) : null,
      method: call.name
    });
  } catch (err) {
    return res.status(500).json({
      ok:false,
      error:"mint_failed",
      message: err?.reason || err?.message || String(err)
    });
  }
});



export default router;