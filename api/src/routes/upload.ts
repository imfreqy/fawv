import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";


const router = express.Router();

const BUCKET = process.env.AWS_S3_BUCKET!;
const REGION = process.env.AWS_REGION || "us-east-1";
const s3 = new S3Client({ region: REGION, 
  requestChecksumCalculation: "NEVER" });


type FileReq = { relPath: string; size: number; contentType?: string };

router.post("/upload/start", async (req, res) => {
  try {
    const { sessionId, files } = req.body as { sessionId?: string; files: FileReq[] };
    if (!files?.length) return res.status(400).json({ error: "no_files" });

    const sid =
      sessionId && /^[a-zA-Z0-9_-]{6,}$/.test(sessionId)
        ? sessionId
        : crypto.randomBytes(8).toString("hex");

    const items = await Promise.all(
      files.map(async (f) => {
        const safePath = f.relPath.replace(/^([./])+/, "").replace(/\.\.\//g, "");
        const key = `demo/${sid}/${safePath}`;
        const contentType = f.contentType || "application/octet-stream";

        const cmd = new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
        });
        const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 }); // 10 min

        return {
          relPath: safePath,
          objectKey: key,
          s3Uri: `s3://${BUCKET}/${key}`,
          uploadUrl,
          contentType,
        };
      })
    );

    res.json({ sessionId: sid, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "presign_failed" });
  }
});

export default router;

