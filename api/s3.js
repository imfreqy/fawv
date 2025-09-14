import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

const s3 = new S3Client({}); // picks up IAM role or env
const BUCKET = process.env.S3_BUCKET;

export async function presignPut(key, contentType, sha256) {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
    Metadata: sha256 ? { sha256 } : undefined,
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 900 });
  return { url };
}

export async function presignGet(key, ttl = 3600) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: ttl });
  return { url };
}

export async function verifySha256(key, expectedHex) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const res = await s3.send(cmd);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    res.Body.on('data', chunk => hash.update(chunk))
            .on('error', reject)
            .on('end', resolve);
  });
  const got = hash.digest('hex');
  return { ok: got === expectedHex.toLowerCase(), got };
}

