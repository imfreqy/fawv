import express from 'express';
import { randomUUID } from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { presignPut, presignGet, verifySha256 } from './s3.js';
import { ethers } from 'ethers';

const router = express.Router();
const s3 = new S3Client({});
const BUCKET = process.env.S3_BUCKET;
const NETWORK = 'sepolia';

// Minimal ABI for the two functions we call
const abi = [
  'function mintVault(address to, string ref) external returns (uint256)',
  'function nextId() view returns (uint256)'
];

function providerWalletAndContract() {
  const { ALCHEMY_API_KEY, SEPOLIA_PRIVATE_KEY, CONTRACT_ADDR } = process.env;
  if (!ALCHEMY_API_KEY || !SEPOLIA_PRIVATE_KEY || !CONTRACT_ADDR) {
    throw new Error('Chain env not set: ALCHEMY_API_KEY, SEPOLIA_PRIVATE_KEY, CONTRACT_ADDR');
  }
  const provider = new ethers.JsonRpcProvider(`https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`);
  const wallet = new ethers.Wallet(SEPOLIA_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDR, abi, wallet);
  return { wallet, contract };
}

router.get('/health', (_req, res) => res.json({ ok: true }));

router.post('/presign', async (req, res) => {
  const { filename, contentType, sha256 } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const safe = String(filename).replace(/[^\w.\-]/g, '_');
  const key = `vaults/${randomUUID()}/${safe}`;
  const { url } = await presignPut(key, contentType || 'application/octet-stream', sha256);
  res.json({ key, url });
});

router.post('/verify', async (req, res) => {
  const { key, sha256 } = req.body || {};
  if (!key || !sha256) return res.status(400).json({ error: 'key and sha256 required' });
  const { ok, got } = await verifySha256(key, sha256);
  res.json({ ok, got });
});

router.post('/commit', async (req, res) => {
  const { key, filename, bytes, sha256, endowmentUsd = 0, tier = 'Permanence', ttlYears = 1, heartbeatMonths = 12 } = req.body || {};
  if (!key || !filename || !bytes || !sha256) return res.status(400).json({ error: 'missing fields' });

  // Build minimal manifest
  const usdPerEth = Number(process.env.USD_PER_ETH || 2500);
  const eth = Number((Number(endowmentUsd) / usdPerEth).toFixed(6));
  const committedAt = new Date().toISOString();
  const next = new Date(); next.setMonth(next.getMonth() + Number(heartbeatMonths));

  const manifest = {
    name: 'FAWV Vault',
    version: 1,
    file: { filename, bytes, sha256: String(sha256).toLowerCase() },
    plan: { tier, ttlYears: Number(ttlYears), heartbeatMonths: Number(heartbeatMonths) },
    endowment: { usd: Number(endowmentUsd), eth, usdPerEth, committedAt },
    storage: { s3: { bucket: BUCKET, key } },
    ops: { nextHeartbeat: next.toISOString() }
  };

  // Write manifest.json next to the file
  const manifestKey = key.replace(/\/[^/]+$/, '/manifest.json');
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: manifestKey, ContentType: 'application/json', Body: JSON.stringify(manifest, null, 2)
  }));

  // Mint real token (requires you to fill env + deploy contract)
  const { contract } = providerWalletAndContract();
  const to = process.env.MINT_TO_ADDRESS;
  const manifestRef = `s3://${BUCKET}/${manifestKey}`;
  const tx = await contract.mintVault(to, manifestRef);
  const rcpt = await tx.wait();
  const nextId = await contract.nextId();
  const tokenId = Number(nextId) - 1;

  manifest.token = { network: NETWORK, contract: process.env.CONTRACT_ADDR, tokenId: String(tokenId), txHash: rcpt.hash, manifestRef };

  // Save manifest again with token info
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: manifestKey, ContentType: 'application/json', Body: JSON.stringify(manifest, null, 2)
  }));

  res.json({ tokenId, txHash: rcpt.hash, manifestKey, manifest, s3: { bucket: BUCKET, key } });
});

router.get('/presign-get', async (req, res) => {
  const { key } = req.query || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  // optional: implement presignGet and return a URL if you want downloads
  res.status(501).json({ error: 'not implemented' });
});

export default router;

