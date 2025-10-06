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

// ------------------------------ Env & Chain ------------------------------
const RPC_URL          = process.env.RPC_URL || process.env.SEPOLIA_RPC_URL || "";
const PRIVATE_KEY      = process.env.PRIVATE_KEY || "";
const DEFAULT_CONTRACT = process.env.CONTRACT_ADDRESS || "";
const MINT_DISABLED    = String(process.env.MINT_DISABLED || "").toLowerCase() === "true";

const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const S3_BUCKET  = process.env.S3_BUCKET || process.env.VAULT_BUCKET || "";
const PUBLIC_JSON_ACL = String(process.env.PUBLIC_JSON_ACL || "").toLowerCase() === "true";

const MINT_VALUE_WEI = (() => {
  const v = String(process.env.MINT_VALUE_WEI || "").trim();
  if (!v) return null;
  try { return BigInt(v); } catch { return null; }
})();

// Debug ABI (optional)
const ABI_PATH = path.resolve(__dirname, "./src/abi/FAWVMinter721.json");
let CONTRACT_ABI = null;
try {
  const json = JSON.parse(fs.readFileSync(ABI_PATH, "utf-8"));
  CONTRACT_ABI = json?.abi ?? null;
  console.log("[ABI] Loaded:", ABI_PATH);
} catch (e) {
  console.warn("[ABI] Could not read:", ABI_PATH, e?.message || e);
}

function getWallet() {
  if (!RPC_URL || !PRIVATE_KEY) return null;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  return new ethers.Wallet(PRIVATE_KEY, provider);
}

// ------------------------------ S3 helpers ------------------------------
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

function resolveLocation({ key, manifestKey, manifestRef, bucket: bodyBucket }) {
  if (manifestRef) {
    const s = String(manifestRef);
    if (s.startsWith("s3://")) {
      const [, , bucket, ...rest] = s.split("/");
      return { bucket, key: rest.join("/"), hintRegion: null };
    }
    let m = s.match(/^https?:\/\/([^.]+)\.s3\.([^.]+)\.amazonaws\.com\/(.+)$/);
    if (m) return { bucket: m[1], key: m[3], hintRegion: m[2] };
    m = s.match(/^https?:\/\/[^/]*s3\.([^.]+)\.amazonaws\.com\/([^/]+)\/(.+)$/);
    if (m) return { bucket: m[2], key: m[3], hintRegion: m[1] };
  }
  const finalKey = key || manifestKey;
  const bucket = bodyBucket || process.env.S3_BUCKET || process.env.VAULT_BUCKET;
  if (!finalKey) throw new Error("key/manifestKey or manifestRef is required");
  if (!bucket) throw new Error("bucket missing: set S3_BUCKET/VAULT_BUCKET, or send { bucket } or manifestRef");
  return { bucket, key: String(finalKey), hintRegion: null };
}

async function getS3ForBucket(bucket, hintRegion) {
  let region = hintRegion || AWS_REGION || "us-east-1";
  let client = new S3Client({ region });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return client;
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

async function putPublicJsonToS3(bucket, key, obj, hintRegion = null) {
  const s3 = await getS3ForBucket(bucket, hintRegion);
  const Body = Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf-8");
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body,
    ContentType: "application/json; charset=utf-8",
    ...(PUBLIC_JSON_ACL ? { ACL: "public-read" } : {}),
  }));
  return { url: `https://${bucket}.s3.amazonaws.com/${key}`, public: PUBLIC_JSON_ACL };
}

// ------------------------------ Price & Sale helpers ------------------------------
async function detectMintPrice(contract) {
  const priceABIs = [
    "function mintPrice() view returns (uint256)",
    "function price() view returns (uint256)",
    "function publicPrice() view returns (uint256)",
    "function whitelistPrice() view returns (uint256)",
    "function presalePrice() view returns (uint256)",
    "function mintCost() view returns (uint256)",
    "function cost() view returns (uint256)",
    "function MINT_PRICE() view returns (uint256)",
    "function PRICE() view returns (uint256)"
  ];
  for (const sig of priceABIs) {
    try {
      const name = sig.match(/function\s+([^(]+)/)[1];
      const tmp = new ethers.Contract(contract.target, [sig], contract.runner);
      const v = await tmp[name]();
      const bi = BigInt(v.toString());
      if (bi >= 0n) return bi;
    } catch (e) {}
  }
  return 0n;
}

async function readSaleStatus(contract) {
  const boolFns = [
    "function saleActive() view returns (bool)",
    "function isSaleActive() view returns (bool)",
    "function isPublicSaleActive() view returns (bool)",
    "function publicSaleActive() view returns (bool)",
    "function isPublicMintEnabled() view returns (bool)",
    "function isMintEnabled() view returns (bool)",
    "function mintEnabled() view returns (bool)",
    "function paused() view returns (bool)"
  ];
  const out = {};
  for (const sig of boolFns) {
    try {
      const name = sig.match(/function\s+([^(]+)/)[1];
      const tmp = new ethers.Contract(contract.target, [sig], contract.runner);
      out[name] = await tmp[name]();
    } catch (e) {}
  }
  return out;
}

// ------------------------------ Diagnostics ------------------------------
router.get("/contract/diagnose", async (_req, res) => {
  try {
    const wallet = getWallet();
    if (!wallet) return res.status(500).json({ ok:false, error:"missing_rpc_or_pk" });
    const contractAddress = DEFAULT_CONTRACT;
    if (!contractAddress) return res.status(400).json({ ok:false, error:"missing_contract_address" });
    const code = await wallet.provider.getCode(contractAddress);
    if (!code || code === "0x") return res.json({ ok:true, contractAddress, code: "0x", msg:"no code at address" });

    const acc = await wallet.getAddress();
    const probe = new ethers.Contract(contractAddress, ["function owner() view returns (address)"], wallet);
    let owner = null;
    try { owner = await probe.owner(); } catch (e) {}
    const ifaceProbe = new ethers.Contract(contractAddress, ["function supportsInterface(bytes4) view returns (bool)"], wallet);
    const supports = {};
    try { supports.ERC165  = await ifaceProbe.supportsInterface("0x01ffc9a7"); } catch (e) {}
    try { supports.ERC721  = await ifaceProbe.supportsInterface("0x80ac58cd"); } catch (e) {}
    try { supports.Meta721 = await ifaceProbe.supportsInterface("0x5b5e139f"); } catch (e) {}
    try { supports.ERC1155 = await ifaceProbe.supportsInterface("0xd9b67a26"); } catch (e) {}

    const sale = await readSaleStatus({ target: contractAddress, runner: wallet });
    const price = await detectMintPrice({ target: contractAddress, runner: wallet });

    res.json({ ok:true, contractAddress, owner, caller: acc, supports, sale, priceWei: price.toString(), codeLen: (code.length/2)-1 });
  } catch (e) {
    res.status(500).json({ ok:false, error:"diagnose_failed", message: e?.message || String(e) });
  }
});

router.get("/contract/scan", async (_req, res) => {
  try {
    const wallet = getWallet();
    if (!wallet) return res.status(500).json({ ok:false, error:"missing_rpc_or_pk" });
    const addr = DEFAULT_CONTRACT;
    if (!addr) return res.status(400).json({ ok:false, error:"missing_contract_address" });

    const provider = wallet.provider;

    // Probe proxy implementation via EIP-1967
    const SLOT_IMPL = "0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC";
    const implSlot = await provider.getStorage(addr, SLOT_IMPL);
    const implAddr = implSlot && implSlot != "0x" ? ("0x" + implSlot.slice(-40)) : null;

    const codeAt = async (a) => await provider.getCode(a);
    const proxyCode = await codeAt(addr);
    const implCode  = implAddr ? await codeAt(implAddr) : null;
    const targetCode = (implCode && implCode != "0x") ? implCode : proxyCode;

    const candidates = [
      // zero-arg
      "mint()",
      "safeMint()",
      // quantity only
      "mint(uint256)",
      "safeMint(uint256)",
      // address only
      "mint(address)",
      "safeMint(address)",
      "mintTo(address)",
      // address + tokenURI
      "mint(address,string)",
      "safeMint(address,string)",
      "mintTo(address,string)",
      "mintNFT(address,string)",
      "mintItem(address,string)",
      "awardItem(address,string)",
      "mintURI(address,string)",
      "mintWithURI(address,string)",
      // address + qty (721A style)
      "mint(address,uint256)",
      "safeMint(address,uint256)",
      "mintTo(address,uint256)",
      "ownerMint(address,uint256)",
      "adminMint(address,uint256)",
      "teamMint(address,uint256)",
      "devMint(address,uint256)",
      "reserveMint(address,uint256)",
      // hash-based
      "mintHash(address,bytes32)",
      "mintVault(address,bytes32,string)",
      "mintRecord(address,bytes32,string)",
      "mintWithHash(address,bytes32,string)"
    ];

    const findings = [];
    const hex = (targetCode || "").toLowerCase().replace(/^0x/, "");
    for (const sig of candidates) {
      const selector = ethers.id(sig).slice(2, 10); // first 4 bytes
      // look for PUSH4 <selector> pattern (63 <4bytes>), or bare selector
      const maybe = hex.includes("63" + selector) || hex.includes(selector);
      findings.push({ signature: sig, selector: "0x" + selector, maybePresent: !!maybe });
    }

    res.json({
      ok: true,
      address: addr,
      proxyCodeLen: proxyCode ? (proxyCode.length/2 - 1) : 0,
      implAddr,
      implCodeLen: implCode ? (implCode.length/2 - 1) : null,
      scannedCode: implCode && implCode !== "0x" ? "implementation" : "proxy",
      findings
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:"scan_failed", message: e?.message || String(e) });
  }
});

// ------------------------------ Upload routes ------------------------------
router.post("/verify-upload", async (req, res) => {
  try {
    const { key } = req.body ?? {};
    if (!key) return res.status(400).json({ ok:false, error:"missing_key" });
    const Bucket = S3_BUCKET;
    if (!Bucket) return res.status(500).json({ ok:false, error:"missing_S3_BUCKET" });

    const s3c = await getS3ForBucket(Bucket, null);
    try {
      await s3c.send(new HeadObjectCommand({ Bucket, Key: key }));
      console.log("[verify-upload] exists", { Bucket, Key: key });
      return res.json({ ok:true, exists:true, bucket: Bucket, key });
    } catch (e) {
      console.warn("[verify-upload] not found", { Bucket, Key: key, code: e?.$metadata?.httpStatusCode, name: e?.name, msg: e?.message });
      return res.json({ ok:true, exists:false, bucket: Bucket, key });
    }
  } catch (err) {
    console.error("verify-upload error", err);
    return res.status(500).json({ ok:false, error:"verify_failed", message: err?.message || String(err) });
  }
});

router.post("/manifest/force-extra", async (req, res) => {
  try {
    const { bucket, key, hintRegion } = (() => {
      const r = resolveLocation(req.body || {});
      return { bucket: r.bucket, key: r.key, hintRegion: r.hintRegion };
    })();
    const { extra } = req.body || {};
    const s3 = await getS3ForBucket(bucket, hintRegion);

    let obj = {};
    try {
      const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = await streamToString(got.Body);
      obj = JSON.parse(body || "{}");
    } catch (e) {
      obj = {};
    }

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

router.post("/upload/start", async (req, res) => {
  try {
    const { sessionId, files, bucket: bodyBucket } = req.body ?? {};
    if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ ok:false, error:"no_files" });
    const Bucket = bodyBucket || S3_BUCKET; if (!Bucket) return res.status(500).json({ ok:false, error:"missing_S3_BUCKET" });

    const s3 = new S3Client({ region: AWS_REGION || "us-east-1" });
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

// ------------------------------ Mint helpers ------------------------------
const MINT_ABI = [
  // zero/qty
  "function mint()",
  "function safeMint()",
  "function mint(uint256 quantity)",
  "function safeMint(uint256 quantity)",

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

  // address/qty (721A style)
  "function mint(address to, uint256 quantity)",
  "function safeMint(address to, uint256 quantity)",
  "function mintTo(address to, uint256 quantity)",
  "function ownerMint(address to, uint256 quantity)",
  "function adminMint(address to, uint256 quantity)",
  "function teamMint(address to, uint256 quantity)",
  "function devMint(address to, uint256 quantity)",
  "function reserveMint(address to, uint256 quantity)",

  // Transfer event
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
];

function buildAdminToggleList(minterAddress) {
  const MINTER_ROLE = ethers.id("MINTER_ROLE");
  return [
    // AccessControl
    ["grantRole(bytes32,address)",            [MINTER_ROLE, minterAddress]],

    // Sale / public mint gates
    ["setPublicSaleActive(bool)",             [true]],
    ["setSaleActive(bool)",                   [true]],
    ["setSaleIsActive(bool)",                 [true]],
    ["setPublic(bool)",                       [true]],
    ["setIsPublicMintEnabled(bool)",          [true]],
    ["setMintEnabled(bool)",                  [true]],
    ["setMintActive(bool)",                   [true]],
    ["setIsSaleActive(bool)",                 [true]],
    ["enableMint()",                          []],
    ["openMint()",                            []],
    ["toggleSaleActive()",                    []],
    ["flipSaleState()",                       []],

    // Pausable
    ["unpause()",                             []],
    ["setPaused(bool)",                       [false]],
    ["pause(bool)",                           [false]],

    // Price → free
    ["setMintPrice(uint256)",                 [0]],
    ["setPrice(uint256)",                     [0]],
    ["setCost(uint256)",                      [0]],
    ["setPublicPrice(uint256)",               [0]],
  ].filter(Boolean);
}

function buildMintCandidates(minterAddress, tokenURI, bytes32Hash, contentKey) {
  return [
    // Zero/qty
    ["mint()",                               []],
    ["safeMint()",                           []],
    ["mint(uint256)",                        [1]],
    ["safeMint(uint256)",                    [1]],

    // Owner/public
    ["safeMint(address)",                    [minterAddress]],
    ["mint(address)",                        [minterAddress]],
    ["mintTo(address)",                      [minterAddress]],
    ["publicMint(uint256)",                  [1]],
    ["mintPublic(uint256)",                  [1]],
    ["mintAllowlist(uint256)",               [1]],

    // TokenURI flavors
    tokenURI ? ["mint(address,string)",        [minterAddress, tokenURI]] : null,
    tokenURI ? ["mintTo(address,string)",      [minterAddress, tokenURI]] : null,
    tokenURI ? ["safeMint(address,string)",    [minterAddress, tokenURI]] : null,
    tokenURI ? ["mintNFT(address,string)",     [minterAddress, tokenURI]] : null,
    tokenURI ? ["mintItem(address,string)",    [minterAddress, tokenURI]] : null,
    tokenURI ? ["awardItem(address,string)",   [minterAddress, tokenURI]] : null,
    tokenURI ? ["mintURI(address,string)",     [minterAddress, tokenURI]] : null,
    tokenURI ? ["mintWithURI(address,string)", [minterAddress, tokenURI]] : null,

    // Hash-based
    (bytes32Hash && contentKey) ? ["mintVault(address,bytes32,string)",    [minterAddress, bytes32Hash, contentKey]] : null,
    (bytes32Hash && contentKey) ? ["mintRecord(address,bytes32,string)",   [minterAddress, bytes32Hash, contentKey]] : null,
    (bytes32Hash && contentKey) ? ["mintWithHash(address,bytes32,string)", [minterAddress, bytes32Hash, contentKey]] : null,
    bytes32Hash ? ["mintHash(address,bytes32)",  [minterAddress, bytes32Hash]] : null,

    // 721A-style owner mints
    ["safeMint(address,uint256)",            [minterAddress, 1]],
    ["mint(address,uint256)",                [minterAddress, 1]],
    ["mintTo(address,uint256)",              [minterAddress, 1]],
    ["ownerMint(address,uint256)",           [minterAddress, 1]],
    ["adminMint(address,uint256)",           [minterAddress, 1]],
    ["teamMint(address,uint256)",            [minterAddress, 1]],
    ["devMint(address,uint256)",             [minterAddress, 1]],
    ["reserveMint(address,uint256)",         [minterAddress, 1]]
  ].filter(Boolean);
}

function valueCandidates(priceWei) {
  const set = new Set();
  set.add(0n);
  if (priceWei && priceWei > 0n) set.add(priceWei);
  if (MINT_VALUE_WEI && MINT_VALUE_WEI > 0n) set.add(MINT_VALUE_WEI);
  set.add(10_000_000_000_000n);   // 0.00001
  set.add(100_000_000_000_000n);  // 0.0001
  set.add(1_000_000_000_000_000n);// 0.001
  return Array.from(set.values());
}

// ------------------------------ Upload & Mint main route ------------------------------
router.post("/hash-and-mint", async (req, res) => {
  console.log("[hash-and-mint] begin");
  try {
    const {
      sessionId,
      manifestKeyClient,
      publicMetadata = {},
      minterAddress: minterAddressIn,
      to,
      s3Key, sha256
    } = req.body ?? {};

    const Bucket = S3_BUCKET;
    const minterAddress = minterAddressIn || to || null;
    if (!Bucket) return res.status(500).json({ ok:false, error:"missing_S3_BUCKET" });
    if (!manifestKeyClient || !sessionId) {
      return res.status(400).json({ ok:false, error:"bad_request", message:"sessionId and manifestKeyClient are required" });
    }

    const s3c = await getS3ForBucket(Bucket, null);
    let manifest = {};
    try {
      const got = await s3c.send(new GetObjectCommand({ Bucket, Key: manifestKeyClient }));
      const body = await streamToString(got.Body);
      manifest = JSON.parse(body || "{}");
    } catch (e) {
      return res.status(400).json({ ok:false, error:"manifest_missing", message:`Could not read ${manifestKeyClient}: ${String(e?.message || e)}` });
    }

    const tokenMeta = {
      name: publicMetadata.name || `FAWV Vault — ${manifest?.name || sessionId}`,
      description: publicMetadata.description || "Vaulted asset",
      image: publicMetadata.image || null,
      external_url: publicMetadata.external_url || null,
      attributes: Array.isArray(publicMetadata.attributes) ? publicMetadata.attributes : [],
      vault_manifest_ref: `s3://${Bucket}/${manifestKeyClient}`
    };
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

    let sha256Hex = (sha256 && String(sha256).replace(/^0x/, "")) || null;
    const contentKey = s3Key
      || manifest?.source?.object_key
      || (Array.isArray(manifest?.files) && manifest.files[0]?.key);
    if (!sha256Hex && contentKey) {
      try {
        const got = await s3c.send(new GetObjectCommand({ Bucket, Key: contentKey }));
        sha256Hex = await streamSha256Hex(got.Body);
      } catch (e) {}
    }
    const bytes32Hash = sha256Hex ? ("0x" + String(sha256Hex).padStart(64, "0")) : null;

    let txHash = null;
    let tokenId = null;
    let contractAddress = DEFAULT_CONTRACT || null;
    let chainError = null;
    let mintFnUsed = null;

    const rpcConfigured = Boolean(RPC_URL && PRIVATE_KEY && contractAddress && minterAddress);

    if (!MINT_DISABLED && rpcConfigured) {
      try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
        const code     = await provider.getCode(contractAddress);

        if (!code || code === "0x") {
          chainError = "no_contract_code_at_CONTRACT_ADDRESS";
        } else {
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

          try {
            const ifaceProbe = new ethers.Contract(contractAddress, ["function supportsInterface(bytes4) view returns (bool)"], wallet);
            const IID_ERC165         = "0x01ffc9a7";
            const IID_ERC721         = "0x80ac58cd";
            const IID_ERC721Metadata = "0x5b5e139f";
            const IID_ERC1155        = "0xd9b67a26";
            const supports = {};
            try { supports.ERC165  = await ifaceProbe.supportsInterface(IID_ERC165); } catch (e) {}
            try { supports.ERC721  = await ifaceProbe.supportsInterface(IID_ERC721); } catch (e) {}
            try { supports.Meta721 = await ifaceProbe.supportsInterface(IID_ERC721Metadata); } catch (e) {}
            try { supports.ERC1155 = await ifaceProbe.supportsInterface(IID_ERC1155); } catch (e) {}
            console.log("[mint][supportsInterface]", supports);
          } catch (e) {}

          const sale = await readSaleStatus({ target: contractAddress, runner: wallet });
          let priceWei = 0n;
          try { priceWei = await detectMintPrice({ target: contractAddress, runner: wallet }); } catch (e) {}
          if (priceWei > 0n) console.log("[mint] price detected (wei):", priceWei.toString());
          const valuesToTry = valueCandidates(priceWei);

          // Admin toggles
          try {
            const adminCandidates = buildAdminToggleList(minterAddress);
            for (const [sig, args] of adminCandidates) {
              try {
                const name = sig.match(/([^(]+)/)[1];
                const admin = new ethers.Contract(contractAddress, [ `function ${sig}` ], wallet);
                await admin.getFunction(name).populateTransaction(...args);
                try { await admin.getFunction(name).staticCall(...args); } catch (e) { continue; }
                const txAdmin = await admin.getFunction(name)(...args);
                console.log("[mint][admin]", sig, "tx:", txAdmin.hash);
              } catch (e) { /* try next */ }
            }
          } catch (e) {}

          // Mint attempts
          const candidateList = buildMintCandidates(minterAddress, tokenURI, bytes32Hash, contentKey);
          outer: for (const [sig, args] of candidateList) {
            const name = sig.match(/([^(]+)/)[1];
            const c = new ethers.Contract(contractAddress, [ `function ${sig}`, "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)" ], wallet);
            try { await c.getFunction(name).populateTransaction(...args); } catch (e) { continue; }
            for (const val of valuesToTry) {
              const overrides = val > 0n ? { value: val } : {};
              try { await c.getFunction(name).staticCall(...args, overrides); }
              catch (staticErr) {
                console.log("[mint] static revert", `${sig} value=${val.toString()}`, "-", staticErr?.shortMessage || staticErr?.reason || staticErr?.code || String(staticErr));
                continue;
              }
              console.log("[mint] using", sig, "value=", val.toString());
              const sent = await c.getFunction(name)(...args, overrides);
              txHash = sent.hash;
              mintFnUsed = sig;
              console.log("[mint] tx", sent.hash);

              try {
                const rc = await provider.waitForTransaction(sent.hash, 0, 20_000);
                if (rc) {
                  const T721  = ethers.id("Transfer(address,address,uint256)");
                  for (const log of rc.logs || []) {
                    if (log.topics?.[0] === T721 && log.topics.length >= 4) {
                      try { tokenId = ethers.toBigInt(log.topics[3]).toString(); break; } catch (e) {}
                    }
                  }
                }
              } catch (e) {}
              break outer;
            }
          }

          if (!txHash) {
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

    // Persist token block
    let chainId = null;
    try {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const net = await provider.getNetwork();
      chainId = Number(net.chainId);
    } catch (e) {}

    manifest.token = {
      ...(manifest.token || {}),
      chainId: chainId ?? manifest.token?.chainId,
      contractAddress: contractAddress || null,
      tokenURI,
      txHash,
      tokenId: tokenId ? String(tokenId) : null,
      mintedAt: tokenId ? new Date().toISOString() : manifest.token?.mintedAt,
      minterAddress: minterAddress || manifest.token?.minterAddress
    };

    await s3c.send(new PutObjectCommand({
      Bucket,
      Key: manifestKeyClient,
      Body: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf-8"),
      ContentType: "application/json; charset=utf-8",
      ServerSideEncryption: "AES256"
    }));

    console.log("[hash-and-mint] done", { sessionId, manifestKeyClient, tokenMetaKey, wroteMeta: !!tokenURI, txHash, tokenId, chainError });

    return res.json({
      ok: true,
      sessionId,
      manifestKeyClient,
      tokenMetaKey,
      tokenURI,
      tokenId: tokenId ? String(tokenId) : null,
      txHash,
      contractAddress,
      chainError,
      mintFnUsed
    });
  } catch (err) {
    console.error("hash-and-mint error", err);
    return res.status(500).json({ ok:false, error:"hash_and_mint_failed", message: err?.message || String(err) });
  }
});

// ------------------------------ Chain health + direct mint ------------------------------
router.get("/chain/health", async (req, res) => {
  try {
    const wallet = getWallet();
    if (!wallet) return res.status(500).json({ ok:false, error:"missing_rpc_or_pk" });
    const provider = wallet.provider;
    const net = await provider.getNetwork();

    const contractAddr = DEFAULT_CONTRACT || String(req.query.contract || "");
    if (!contractAddr) return res.status(400).json({ ok:false, error:"missing_contract_address" });

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

router.post("/mint/token", async (req, res) => {
  try {
    const { to, tokenURI, bytes32Hash, contentKey, contractAddress } = req.body ?? {};
    const wallet = getWallet();
    if (!wallet) return res.status(500).json({ ok:false, error:"missing_rpc_or_pk" });
    if (!to) return res.status(400).json({ ok:false, error:"missing_to" });
    if (!tokenURI && !bytes32Hash) return res.status(400).json({ ok:false, error:"need_tokenURI_or_bytes32Hash" });

    const address = contractAddress || DEFAULT_CONTRACT;
    if (!address) return res.status(400).json({ ok:false, error:"missing_contract_address" });

    const contract = new ethers.Contract(address, MINT_ABI, wallet);

    let price = 0n;
    try { price = await detectMintPrice(contract); } catch (e) {}
    const vals = valueCandidates(price);
    let tx = null, used = null, usedVal = null;

    const cand = buildMintCandidates(to, tokenURI, bytes32Hash, contentKey);
    for (const [sig, args] of cand) {
      const name = sig.match(/([^(]+)/)[1];
      try { await contract.getFunction(name).populateTransaction(...args); } catch (e) { continue; }

      for (const v of vals) {
        const overrides = v > 0n ? { value: v } : {};
        try { await contract.getFunction(name).staticCall(...args, overrides); }
        catch (staticErr) { continue; }

        used = name; usedVal = v;
        tx = await contract.getFunction(name)(...args, overrides);
        break;
      }
      if (tx) break;
    }
    if (!tx) return res.status(400).json({ ok:false, error:"no_supported_mint_method_in_abi" });

    let tokenId = null;
    try {
      const iface = new ethers.Interface(MINT_ABI);
      const rc = await wallet.provider.waitForTransaction(tx.hash, 0, 12000);
      if (rc) {
        for (const log of rc.logs || []) {
          try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === "Transfer") {
              tokenId = (parsed.args?.tokenId ?? parsed.args?.[2])?.toString?.() || tokenId;
              break;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    return res.json({
      ok: true,
      contractAddress: address,
      txHash: tx.hash,
      tokenId: tokenId ? String(tokenId) : null,
      method: used,
      valueWei: usedVal !== null ? usedVal.toString() : null
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error:"mint_failed", message: err?.reason || err?.message || String(err) });
  }
});

router.get("/tx-status", async (req, res) => {
  try {
    const tx = String(req.query?.tx || "");
    if (!tx) return res.status(400).json({ ok:false, error:"missing_tx" });
    const wallet = getWallet();
    if (!wallet) return res.status(500).json({ ok:false, error:"missing_rpc_or_pk" });

    const receipt = await wallet.provider.getTransactionReceipt(tx);
    if (!receipt) return res.json({ ok:true, status:"pending", tokenId: null, confirmations: 0 });

    const TRANSFER_TOPIC_721  = ethers.id("Transfer(address,address,uint256)");
    let tokenId = null;
    for (const log of receipt.logs || []) {
      if (log.topics && log.topics[0] === TRANSFER_TOPIC_721 && log.topics.length >= 4) {
        try { tokenId = ethers.toBigInt(log.topics[3]).toString(); break; } catch (e) {}
      }
    }
    return res.json({
      ok: true,
      status: receipt.status === 1 ? "confirmed" : "failed",
      tokenId: tokenId ? String(tokenId) : null,
      confirmations: receipt.confirmations || 0
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error:"tx_status_failed", message: err?.reason || err?.message || String(err) });
  }
});

export default router;